import type { Plugin } from "@opencode/plugin"
import { isRecord } from "@oh-my-opencode/utils"
import { clearSessionPromptParams } from "./shared/session-prompt-params-state"
import { clearInternalMarkerCache } from "./v2-request"

export function extractDeletedSessionID(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "session.deleted") return undefined
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

export async function registerLifecycleV2(ctx: Plugin.Context): Promise<() => void> {
  const controller = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      const sessionID = extractDeletedSessionID(event)
      if (!sessionID) continue
      clearSessionPromptParams(sessionID)
      clearInternalMarkerCache(sessionID)
    }
  })().catch(() => {})
  return () => controller.abort()
}
