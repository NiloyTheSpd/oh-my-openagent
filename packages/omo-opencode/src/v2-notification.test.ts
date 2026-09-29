import { describe, expect, it } from "bun:test"
import { isRecord } from "@oh-my-opencode/utils"
import { toV1EventProperties } from "./v2-notification"

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
