import type { Plugin } from "@opencode/plugin"
import { isRecord } from "@oh-my-opencode/utils"
import {
  clearSessionAgent,
  getMainSessionID,
  setMainSession,
  subagentSessions,
} from "./features/claude-code-session-state"
import { clearSessionPromptParams } from "./shared/session-prompt-params-state"
import { clearInternalMarkerCache } from "./v2-request"
import { clearPromptSessionState } from "./v2-prompt"

export function extractEventSessionID(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined
  for (const key of ["properties", "data", "payload"]) {
    const container = event[key]
    if (!isRecord(container)) continue
    const sessionID = container.sessionID ?? container.sessionId
    if (typeof sessionID === "string" && sessionID.length > 0) return sessionID
  }
  if (typeof event.sessionID === "string" && event.sessionID.length > 0) {
    return event.sessionID
  }
  return undefined
}

export function extractDeletedSessionID(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "session.deleted") return undefined
  return extractEventSessionID(event)
}

const V2_SESSION_START_EVENTS = new Set([
  "session.inbox.enqueued",
  "session.execution.started",
])

export function isV2SessionStartEvent(event: unknown): boolean {
  return isRecord(event) && typeof event.type === "string" && V2_SESSION_START_EVENTS.has(event.type)
}

async function resolveParentID(ctx: Plugin.Context, sessionID: string): Promise<string | undefined> {
  try {
    const info = await ctx.session.get({ sessionID })
    const parentID = (info as { parentID?: unknown }).parentID
    return typeof parentID === "string" && parentID.length > 0 ? parentID : undefined
  } catch {
    return undefined
  }
}

function extractSessionInfo(event: unknown): { id?: string; parentID?: string } {
  if (!isRecord(event)) return {}
  for (const key of ["properties", "data", "payload"]) {
    const container = event[key]
    if (!isRecord(container)) continue
    const info = container.info
    if (isRecord(info)) {
      return {
        ...(typeof info.id === "string" ? { id: info.id } : {}),
        ...(typeof info.parentID === "string" ? { parentID: info.parentID } : {}),
      }
    }
    if (typeof container.sessionID === "string") return { id: container.sessionID }
  }
  return {}
}

function clearAllSessionState(sessionID: string): void {
  clearSessionPromptParams(sessionID)
  clearInternalMarkerCache(sessionID)
  clearPromptSessionState(sessionID)
  clearSessionAgent(sessionID)
  subagentSessions.delete(sessionID)
  if (getMainSessionID() === sessionID) setMainSession(undefined)
}

export async function registerLifecycleV2(
  ctx: Plugin.Context,
  extra?: { onSessionDeleted?: ((sessionID: string) => void)[] },
): Promise<() => void> {
  const controller = new AbortController()
  const seenSessions = new Set<string>()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (!isRecord(event)) continue
      if (isV2SessionStartEvent(event)) {
        const sessionID = extractEventSessionID(event)
        if (!sessionID || seenSessions.has(sessionID)) continue
        seenSessions.add(sessionID)
        // `session.created` is documented in the V2 event union but is never
        // delivered to a plugin subscriber: it is emitted before setup finishes.
        // A live probe of `opencode run` captured 0 occurrences. The first
        // session event that actually arrives is the reliable signal, and it
        // carries no parentID, so the session is fetched to classify it.
        const parentID = await resolveParentID(ctx, sessionID)
        if (parentID) {
          subagentSessions.add(sessionID)
        } else {
          setMainSession(sessionID)
        }
        continue
      }
      const sessionID = extractDeletedSessionID(event)
      if (!sessionID) continue
      seenSessions.delete(sessionID)
      clearAllSessionState(sessionID)
      for (const handler of extra?.onSessionDeleted ?? []) {
        try {
          handler(sessionID)
        } catch {
          // Per-hook cleanup must not break the shared subscription.
        }
      }
    }
  })().catch(() => {})
  return () => controller.abort()
}
