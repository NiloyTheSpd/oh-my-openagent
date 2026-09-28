import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { registerToolGuardV2Hooks, stripMcpPrefix } from "./v2-tool-guards"

type CapturedEvent = {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  id: string
  input: unknown
}

describe("v2 tool guards", () => {
  it("strips the mcp_ prefix", () => {
    // given a model-emitted mcp_ tool name
    // when normalized
    // then the registry name is restored
    expect(stripMcpPrefix("mcp_background_output")).toBe("background_output")
    expect(stripMcpPrefix("read")).toBe("read")
  })

  it("registers an execute.before hook that normalizes the tool call", async () => {
    // given a fake v2 context capturing the hook callback
    let captured: ((event: CapturedEvent) => Promise<void> | void) | undefined
    const ctx = {
      location: { directory: "/tmp/v2-guard-test" },
      tool: {
        hook: async (
          _name: string,
          callback: (event: CapturedEvent) => Promise<void> | void,
        ) => {
          captured = callback
        },
      },
    }
    const event: CapturedEvent = {
      tool: "mcp_read",
      sessionID: "ses-test",
      agent: "build",
      messageID: "msg-test",
      id: "call-test",
      input: { filePath: "/tmp/v2-guard-test/notes.md" },
    }

    // when setup registers guards and the server invokes the callback
    await registerToolGuardV2Hooks(ctx as unknown as Plugin.Context)
    await captured?.(event)

    // then the tool name was normalized and args pass through
    expect(captured).not.toBeUndefined()
    expect(event.tool).toBe("read")
    expect(event.input).toEqual({ filePath: "/tmp/v2-guard-test/notes.md" })
  })
})
