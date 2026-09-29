import type { Plugin } from "@opencode/plugin"
import {
  createModelFallbackStateController,
  type ModelFallbackStateController,
} from "./hooks/model-fallback/fallback-state-controller"
import { getSessionAgent } from "./features/claude-code-session-state"
import { isRecord } from "@oh-my-opencode/utils"
import { log } from "./shared/logger"
import { extractEventSessionID } from "./v2-lifecycle"

// V1 armed a pending fallback inside a `chat.message` hook that rewrote
// `output.message.model` to the next reachable chain entry. V2 declares
// `SessionRequest.model` as readonly, so the outbound request cannot be rewritten.
// This port keeps V1's reachability chain and state controller untouched and applies
// the swap imperatively through `ctx.session.switchModel`, which accepts the same
// provider / model / variant triple. The swap therefore lands on `session.error`
// instead of on the following user message. That timing shift is the one behavioral
// difference from V1; the chain, the no-op skip, and the exhaustion guard are V1's.

const sessionModels = new Map<string, { providerID: string; modelID: string }>()

export function recordSessionModelV2(sessionID: string, model: { providerID: string; id: string }): void {
  sessionModels.set(sessionID, { providerID: model.providerID, modelID: model.id })
}

export function getSessionModelV2(sessionID: string): { providerID: string; modelID: string } | undefined {
  return sessionModels.get(sessionID)
}

export function clearSessionModelV2(sessionID: string): void {
  sessionModels.delete(sessionID)
}

export type V2ModelFallbackPorts = {
  switchModel: (input: {
    sessionID: string
    model: { id: string; providerID: string; variant?: string }
  }) => Promise<void>
  getAgent: (sessionID: string) => string | undefined
  getModel: (sessionID: string) => { providerID: string; modelID: string } | undefined
  onApplied?: (input: {
    sessionID: string
    providerID: string
    modelID: string
    variant?: string
  }) => void | Promise<void>
}

export function newV2ModelFallbackController(): ModelFallbackStateController {
  return createModelFallbackStateController({
    pendingModelFallbacks: new Map(),
    lastToastKey: new Map(),
    sessionFallbackChains: new Map(),
  })
}

/**
 * Arms the V1 fallback controller for a failed session and applies the next
 * reachable fallback through the injected `switchModel` port.
 *
 * Returns the applied fallback, or null when nothing was applied (no agent
 * recorded, no model recorded, no chain, or the chain is exhausted).
 */
export async function applyV2ModelFallback(
  controller: ModelFallbackStateController,
  ports: V2ModelFallbackPorts,
  sessionID: string,
): Promise<{ providerID: string; modelID: string; variant?: string } | null> {
  const agentName = ports.getAgent(sessionID)
  if (!agentName) {
    log("[v2-model-fallback] No agent recorded for session, cannot resolve a chain", { sessionID })
    return null
  }

  const current = ports.getModel(sessionID)
  if (!current) {
    log("[v2-model-fallback] No model recorded for session, cannot resolve a fallback", { sessionID })
    return null
  }

  const armed = controller.setPendingModelFallback(
    sessionID,
    agentName,
    current.providerID,
    current.modelID,
  )
  if (!armed) return null

  const fallback = controller.getNextFallback(sessionID)
  if (!fallback) return null

  await ports.switchModel({
    sessionID,
    model: {
      id: fallback.modelID,
      providerID: fallback.providerID,
      ...(fallback.variant === undefined ? {} : { variant: fallback.variant }),
    },
  })

  // V1 raised a toast here. V2 exposes no tui.showToast, so the swap is logged
  // instead. Reuse the V1 toast key so a repeated chain position logs once.
  const key = `${sessionID}:${fallback.providerID}/${fallback.modelID}:${fallback.variant ?? ""}`
  if (controller.lastToastKey.get(sessionID) !== key) {
    controller.lastToastKey.set(sessionID, key)
    log("[v2-model-fallback] Switched session to fallback model", {
      sessionID,
      agent: agentName,
      providerID: fallback.providerID,
      modelID: fallback.modelID,
      variant: fallback.variant,
    })
  }

  await ports.onApplied?.({
    sessionID,
    providerID: fallback.providerID,
    modelID: fallback.modelID,
    variant: fallback.variant,
  })

  return fallback
}

export function registerModelFallbackV2(ctx: Plugin.Context): () => void {
  const controller = newV2ModelFallbackController()
  const abortController = new AbortController()

  const ports: V2ModelFallbackPorts = {
    switchModel: (input) => ctx.session.switchModel(input),
    getAgent: getSessionAgent,
    getModel: getSessionModelV2,
  }

  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: abortController.signal })) {
      if (!isRecord(event)) continue

      if (event.type === "session.deleted") {
        const sessionID = extractEventSessionID(event)
        if (sessionID) {
          clearSessionModelV2(sessionID)
          controller.clearPendingModelFallback(sessionID)
        }
        continue
      }

      // V1 keyed this off the `session.error` hook. V2 has no `session.error` event at
      // all; a failed model request surfaces as `session.execution.failed` with
      // `data.sessionID` and `data.error`. `session.error` is still accepted so the
      // port keeps working if a future release reintroduces the V1 name.
      const type = String(event.type)
      if (type !== "session.execution.failed" && type !== "session.error") continue
      const sessionID = extractEventSessionID(event)
      if (!sessionID) continue

      try {
        await applyV2ModelFallback(controller, ports, sessionID)
      } catch (error) {
        log("[v2-model-fallback] Fallback switch failed", { sessionID, error: String(error) })
      }
    }
  })().catch(() => {
    // The event stream is best-effort; a dropped subscription must not take down setup.
  })

  return () => abortController.abort()
}
