import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { registerAutoUpdateCheckerV2 } from "./v2-auto-update"
import type { OhMyOpenCodeConfig } from "./config"

function config(overrides: Partial<OhMyOpenCodeConfig> = {}): OhMyOpenCodeConfig {
  return overrides as OhMyOpenCodeConfig
}

// The real V1 hook schedules a 5s deferred check that refreshes the shared
// model-capability cache. Letting that run here would outlive the test and leak into
// suites that read the same cache, so the factory is stubbed and the wiring is
// asserted instead.
function stubFactory(calls: string[]) {
  return ((_ctx: unknown, _options: unknown, _deps: unknown) => ({
    event: () => {
      calls.push("event")
    },
  })) as unknown as typeof import("./hooks/auto-update-checker").createAutoUpdateCheckerHook
}

const context = {
  location: { directory: "/tmp/v2-auto-update-test" },
  event: {
    subscribe: () => {
      throw new Error("subscribe must not be used; session.created never arrives")
    },
  },
}

describe("v2 auto-update-checker", () => {
  it("arms the startup check at setup without waiting for a session event", () => {
    // given a stubbed V1 factory
    const calls: string[] = []

    // when registered
    const stop = registerAutoUpdateCheckerV2(
      context as unknown as Plugin.Context,
      config(),
      stubFactory(calls),
    )

    // then the hook is driven exactly once at setup and teardown is safe
    expect(calls).toEqual(["event"])
    expect(() => stop()).not.toThrow()
  })

  it("does not drive the hook when it is disabled", () => {
    // given the hook listed in disabled_hooks
    const calls: string[] = []

    // when registered
    const stop = registerAutoUpdateCheckerV2(
      context as unknown as Plugin.Context,
      config({ disabled_hooks: ["auto-update-checker"] }),
      stubFactory(calls),
    )

    // then nothing was driven
    expect(calls).toEqual([])
    expect(() => stop()).not.toThrow()
  })
})
