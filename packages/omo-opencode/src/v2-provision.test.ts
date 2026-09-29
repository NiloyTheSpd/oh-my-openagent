import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { registerAstGrepProvisionV2 } from "./v2-provision"
import type { OhMyOpenCodeConfig } from "./config"
import { isV2SessionStartEvent } from "./v2-lifecycle"

function config(overrides: Partial<OhMyOpenCodeConfig> = {}): OhMyOpenCodeConfig {
  return overrides as OhMyOpenCodeConfig
}

describe("v2 ast-grep provision", () => {
  it("arms provisioning at setup without waiting for a session event", () => {
    // given a context whose event stream must never be consulted
    const ctx = {
      event: {
        subscribe: () => {
          throw new Error("subscribe must not be used; session.created never arrives")
        },
      },
    }

    // when registered
    // then it does not throw and teardown is safe
    const stop = registerAstGrepProvisionV2(ctx as unknown as Plugin.Context, config())
    expect(() => stop()).not.toThrow()
  })

  it("is a no-op when the hook is disabled", () => {
    // given the hook listed in disabled_hooks
    const ctx = { event: { subscribe: () => { throw new Error("must not subscribe") } } }

    // when registered
    const stop = registerAstGrepProvisionV2(
      ctx as unknown as Plugin.Context,
      config({ disabled_hooks: ["ast-grep-sg-provision"] }),
    )

    // then it neither subscribes nor throws
    expect(() => stop()).not.toThrow()
  })
})

// A live probe of a real `opencode run` captured zero `session.created` events on the
// plugin subscribe stream, so main-session detection keys off the first session event
// that actually arrives. These pin that choice against the observed event names.
describe("v2 session start detection", () => {
  it("treats the first observed session events as session start", () => {
    // given the session events a live run actually delivered
    // when matched
    // then each is recognized as a session start
    expect(isV2SessionStartEvent({ type: "session.inbox.enqueued", data: { sessionID: "ses_a" } })).toBe(true)
    expect(isV2SessionStartEvent({ type: "session.execution.started", data: { sessionID: "ses_a" } })).toBe(true)
  })

  it("does not treat later or unrelated events as session start", () => {
    // given events that arrive after the session is already known
    // when matched
    // then they are not session starts
    for (const type of [
      "session.idle",
      "session.step.started",
      "session.text.delta",
      "session.execution.succeeded",
      "session.deleted",
      "location.shutdown",
    ]) {
      expect(isV2SessionStartEvent({ type, data: { sessionID: "ses_a" } })).toBe(false)
    }
    expect(isV2SessionStartEvent(undefined)).toBe(false)
  })
})
