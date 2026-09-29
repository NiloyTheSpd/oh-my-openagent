import type { Plugin } from "@opencode/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import type { OhMyOpenCodeConfig } from "./config"
import { isRecord } from "@oh-my-opencode/utils"
import { log } from "./shared/logger"
import { createSessionNotification } from "./hooks/session-notification"
import { isV2HookEnabled } from "./v2-enabled"

// V1 delivered session-notification through the V1 `event` hook and read session
// state through `ctx.client`. V2 has no client at all (ADR-004), so this port:
//
//   1. consumes the `ctx.event.subscribe` stream that v2-lifecycle already uses;
//   2. normalizes V2's `{ type, data }` envelope into the flat property bag the V1
//      helpers read (`sessionID`, `info`, `part`, `tool`, `args`);
//   3. hands the V1 hook a stub whose `client.session` exists but is empty, which
//      trips the hook's own `typeof hookCtx.client.session.get !== "function"`
//      guard and selects its documented base-title/base-message path instead of
//      the session-content enrichment. A `client: {}` stub would throw on that
//      property read, so the empty `session` object is load-bearing;
//   4. substitutes the `skipIfIncompleteTodos` gate. The gate reads
//      `ctx.client.session.todo`, which has no V2 equivalent, so the port reports
//      "no pending work" and may notify while todos are still open. This is a
//      deliberate, documented degradation (see e04s05).

const NOTIFICATION_HOOK_NAME = "session-notification"

function createNotificationCtxStub(directory: string): PluginInput {
  // `client.session` must be an object (not undefined) so the V1 hook's typeof
  // guard evaluates without throwing. No client method is ever called.
  return { directory, client: { session: {} } } as unknown as PluginInput
}

/**
 * Flattens the V2 `{ type, data }` event envelope into the flat property bag the
 * V1 helpers read: `sessionID` / `sessionId`, `info.*`, `part.*`, `tool`, `args`.
 */
export function toV1EventProperties(event: unknown): Record<string, unknown> {
  if (!isRecord(event)) return {}
  let properties: Record<string, unknown> = {}
  for (const key of ["properties", "data", "payload"]) {
    const container = event[key]
    if (isRecord(container)) properties = { ...properties, ...container }
  }
  if (properties.sessionID === undefined && typeof event.sessionID === "string") {
    properties.sessionID = event.sessionID
  }
  return properties
}

export function registerSessionNotificationV2(
  ctx: Plugin.Context,
  pluginConfig: OhMyOpenCodeConfig,
): () => void {
  if (!isV2HookEnabled(pluginConfig, NOTIFICATION_HOOK_NAME)) {
    return () => {}
  }

  const handle = createSessionNotification(createNotificationCtxStub(ctx.location.directory))
  const abortController = new AbortController()

  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: abortController.signal })) {
      if (!isRecord(event) || typeof event.type !== "string") continue
      try {
        await handle({ event: { type: event.type, properties: toV1EventProperties(event) } })
      } catch (error) {
        log("[v2-notification] Notification handler failed", { type: event.type, error: String(error) })
      }
    }
  })().catch(() => {
    // The event stream is best-effort; a dropped subscription must not take down setup.
  })

  log("[v2-notification] registered", {
    todoGate: "degraded: no V2 todo API, idle notifications fire regardless of open todos",
  })

  return () => abortController.abort()
}
