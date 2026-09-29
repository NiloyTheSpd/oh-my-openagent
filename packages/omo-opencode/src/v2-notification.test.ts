import { describe, expect, it } from "bun:test"
import { isRecord } from "@oh-my-opencode/utils"
import { toV1EventProperties, toV1EventType } from "./v2-notification"

const SESSION_ID = "ses-notify-test"

describe("v2 notification event normalization", () => {
  it("flattens the v2 data envelope into v1 property shape", () => {
    // given a v2 event carrying its payload under data
    const event = { type: "session.idle", data: { sessionID: SESSION_ID } }

    // when normalized
    const properties = toV1EventProperties(event)

    // then the v1 helpers can read sessionID off the top level
    expect(properties.sessionID).toBe(SESSION_ID)
  })

  it("preserves nested info and part records the v1 helpers read", () => {
    // given a message event nesting the id under data.info
    const event = { type: "message.updated", data: { info: { id: SESSION_ID } } }

    // when normalized
    const properties = toV1EventProperties(event)

    // then the nested record survives the flatten
    expect(isRecord(properties.info)).toBe(true)
    expect((properties.info as Record<string, unknown>).id).toBe(SESSION_ID)
  })

  it("preserves the tool and args fields used for question detection", () => {
    // given a tool event with an args bag
    const event = {
      type: "tool.execute.before",
      data: {
        sessionID: SESSION_ID,
        tool: "question",
        args: { questions: [{ question: "May I proceed?" }] },
      },
    }

    // when normalized
    const properties = toV1EventProperties(event)

    // then tool and args are readable by the v1 detector
    expect(properties.tool).toBe("question")
    expect(isRecord(properties.args)).toBe(true)
  })

  it("falls back to a top-level sessionID when the envelope omits it", () => {
    // given an event with a bare top-level sessionID
    const event = { type: "session.idle", sessionID: SESSION_ID }

    // when normalized
    const properties = toV1EventProperties(event)

    // then the top-level id is used
    expect(properties.sessionID).toBe(SESSION_ID)
  })

  it("returns an empty bag for non-record input instead of throwing", () => {
    // given malformed event payloads
    // when normalized
    // then an empty bag is returned so the subscriber can skip the event
    expect(toV1EventProperties(undefined)).toEqual({})
    expect(toV1EventProperties("session.idle")).toEqual({})
    expect(toV1EventProperties({ type: "session.idle", data: "not-a-record" })).toEqual({})
  })
})

// A live probe of a real V2 run (2026-09-29) showed the V2 session event vocabulary
// shares no names with the V1 message/tool events the notification hook keys off.
// Without the name map the hook would never observe activity and would notify on a
// busy session, so every mapping the hook depends on is pinned here.
describe("v2 notification event name mapping", () => {
  it("maps every observed v2 activity event onto a v1 activity name", () => {
    // given the v2 event names a live run actually emitted
    const observed = [
      "session.inbox.enqueued",
      "session.instructions.updated",
      "session.text.started",
      "session.text.delta",
      "session.text.ended",
      "session.step.started",
      "session.step.streamed",
      "session.step.ended",
      "session.usage.updated",
      "session.tool.called",
      "session.tool.success",
      "session.tool.failed",
    ]

    // when mapped
    const mapped = observed.map(toV1EventType)

    // then each lands on a v1 name the hook treats as activity
    const activityNames = new Set([
      "message.updated",
      "message.part.updated",
      "message.part.delta",
      "tool.execute.before",
      "tool.execute.after",
    ])
    for (const name of mapped) {
      expect(activityNames.has(name)).toBe(true)
    }
  })

  it("passes through the v2 session lifecycle names the hook reads directly", () => {
    // given v2 lifecycle events
    // when mapped
    // then they are unchanged, because the hook already reads these names
    for (const name of ["session.created", "session.idle", "session.deleted", "permission.asked"]) {
      expect(toV1EventType(name)).toBe(name)
    }
  })

  it("leaves unrelated v2 events untouched rather than inventing activity", () => {
    // given non-session v2 events observed during startup
    // when mapped
    // then they pass through so they cannot be mistaken for session activity
    for (const name of ["mcp.status.changed", "agent.updated", "location.shutdown", "model.updated"]) {
      expect(toV1EventType(name)).toBe(name)
    }
  })
})
