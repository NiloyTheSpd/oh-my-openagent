import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import {
  adaptV1Tool,
  registerPureToolsV2,
  registerToolAfterV2Hooks,
} from "./v2-tools"
import { createModelCacheState } from "./plugin-state"

describe("v2 tools", () => {
  it("adapts a v1 tool to json-schema input and content output", async () => {
    // given a minimal v1-style tool definition
    const calls: { args: unknown; directory: unknown }[] = []
    const definition = {
      description: "test tool",
      args: {},
      execute: async (args: unknown, context: unknown) => {
        const record = context as Record<string, unknown>
        calls.push({ args, directory: record.directory })
        return "done"
      },
    }

    // when adapted and executed
    const adapted = adaptV1Tool("test-tool", definition as never, "/tmp/v2-tools-test")
    const result = await adapted.execute({ a: 1 }, { signal: new AbortController().signal })

    // then schema converted and directory threaded through
    expect(adapted.input.type).toBe("object")
    expect(result).toEqual({ content: "done" })
    expect(calls[0]?.directory).toBe("/tmp/v2-tools-test")
  })

  it("registers grep and glob without overwriting existing tools", async () => {
    // given a fake tool editor with grep pre-existing
    const added: string[] = []
    const ctx = {
      location: { directory: "/tmp/v2-tools-test" },
      tool: {
        transform: async (callback: (editor: {
          get: (id: string) => unknown
          add: (tool: { name: string }) => void
        }) => void) => {
          callback({
            get: (id: string) => (id === "grep" ? { id } : undefined),
            add: (tool: { name: string }) => {
              added.push(tool.name)
            },
          })
        },
      },
    }

    // when registered
    await registerPureToolsV2(ctx as unknown as Plugin.Context, "/tmp/v2-tools-test")

    // then glob added, grep untouched
    expect(added).toEqual(["glob"])
  })

  it("applies delegate-task-retry guidance to a completed task result", async () => {
    // given a fake after-hook capture and a delegate task result carrying a
    // retryable error the V1 patterns recognize
    let captured: ((event: {
      status: string
      tool: string
      sessionID: string
      id: string
      result: { content: unknown }
    }) => Promise<void>) | undefined
    const ctx = {
      location: { directory: "/tmp/v2-tools-test" },
      tool: {
        hook: async (
          _name: string,
          callback: (event: {
            status: string
            tool: string
            sessionID: string
            id: string
            result: { content: unknown }
          }) => Promise<void>,
        ) => {
          captured = callback
        },
      },
    }
    const failure = "[ERROR] missing required parameter: run_in_background"

    await registerToolAfterV2Hooks(ctx as unknown as Plugin.Context, {
      fsyncAfter: async () => {},
      commentCheckerAfter: undefined,
      webfetchAfter: undefined,
      rulesAfter: undefined,
      rulesDeleted: undefined,
      modelCacheState: createModelCacheState(),
      pluginConfig: {} as never,
    })
    const event = {
      status: "completed",
      tool: "task",
      sessionID: "ses-delegate-retry",
      id: "call-delegate-retry",
      result: { content: failure },
    }

    // when the after-chain runs
    // then the retry guidance is appended to the result content in place
    expect(captured).toBeDefined()
    await captured!(event)
    const content = (event.result as { content: string }).content
    expect(content).toContain("run_in_background")
    expect(content.length).toBeGreaterThan(failure.length)
  })

  it("leaves non-task results untouched when delegate-task-retry is registered", async () => {
    // given the same chain and a non-task tool
    let captured: ((event: {
      status: string
      tool: string
      sessionID: string
      id: string
      result: { content: unknown }
    }) => Promise<void>) | undefined
    const ctx = {
      location: { directory: "/tmp/v2-tools-test" },
      tool: {
        hook: async (
          _name: string,
          callback: (event: {
            status: string
            tool: string
            sessionID: string
            id: string
            result: { content: unknown }
          }) => Promise<void>,
        ) => {
          captured = callback
        },
      },
    }
    const original = "[ERROR] missing required parameter: run_in_background"

    await registerToolAfterV2Hooks(ctx as unknown as Plugin.Context, {
      fsyncAfter: async () => {},
      commentCheckerAfter: undefined,
      webfetchAfter: undefined,
      rulesAfter: undefined,
      rulesDeleted: undefined,
      modelCacheState: createModelCacheState(),
      pluginConfig: {} as never,
    })
    const event = {
      status: "completed",
      tool: "read",
      sessionID: "ses-delegate-retry-2",
      id: "call-delegate-retry-2",
      result: { content: original },
    }

    // when the after-chain runs
    await captured!(event)

    // then the result is unchanged, because the guard is tool-scoped
    expect((event.result as { content: string }).content).toBe(original)
  })

  it("runs after-guards on completed string results only", async () => {
    // given a fake after-hook capture
    let captured: ((event: {
      status: string
      tool: string
      sessionID: string
      id: string
      result: { content: unknown }
    }) => Promise<void>) | undefined
    const ctx = {
      location: { directory: "/tmp/v2-tools-test" },
      tool: {
        hook: async (
          _name: string,
          callback: (event: {
            status: string
            tool: string
            sessionID: string
            id: string
            result: { content: unknown }
          }) => Promise<void>,
        ) => {
          captured = callback
        },
      },
    }
    const completedEvent = {
      status: "completed",
      tool: "Task",
      sessionID: "ses-after-test",
      id: "call-after-test",
      result: { content: "   " },
    }
    const errorEvent = {
      status: "error",
      tool: "read",
      sessionID: "ses-after-test",
      id: "call-after-test-2",
      result: { content: "   " },
    }

    // when registered and invoked
    await registerToolAfterV2Hooks(ctx as unknown as Plugin.Context, {
      fsyncAfter: async () => {},
      commentCheckerAfter: undefined,
      webfetchAfter: undefined,
      rulesAfter: undefined,
      rulesDeleted: undefined,
      modelCacheState: createModelCacheState(),
      pluginConfig: {},
    })
    await captured?.(completedEvent)
    await captured?.(errorEvent)

    // then the empty task response was replaced, error events skipped
    expect(captured).not.toBeUndefined()
    expect(completedEvent.result.content).not.toBe("   ")
    expect(errorEvent.result.content).toBe("   ")
  })

  it("injects project rules into read output", async () => {
    // given a project rule file and a fake after-hook capture
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs")
    const root = "/tmp/v2-rules-test"
    mkdirSync(`${root}/.omo/rules`, { recursive: true })
    writeFileSync(`${root}/.omo/rules/demo.md`, "---\nalwaysApply: true\n---\n# Demo rule MARKER-RULEQA\n")
    writeFileSync(`${root}/note.txt`, "note body")
    let captured: ((event: {
      status: string
      tool: string
      sessionID: string
      id: string
      input: unknown
      result: { content: unknown }
    }) => Promise<void>) | undefined
    const ctx = {
      location: { directory: root },
      tool: {
        hook: async (
          _name: string,
          callback: (event: {
            status: string
            tool: string
            sessionID: string
            id: string
            input: unknown
            result: { content: unknown }
          }) => Promise<void>,
        ) => {
          captured = callback
        },
      },
    }
    const event = {
      status: "completed",
      tool: "read",
      sessionID: "ses-rules-test",
      id: "call-rules-test",
      input: { path: `${root}/note.txt` },
      result: { content: "note body" },
    }

    try {
      // when registered through the production wiring and invoked
      const { registerToolGuardV2Hooks } = await import("./v2-tool-guards")
      const guards = await registerToolGuardV2Hooks(ctx as never, {
        pluginConfig: {},
        modelCacheState: createModelCacheState(),
      })
      await registerToolAfterV2Hooks(ctx as unknown as Plugin.Context, {
        fsyncAfter: guards.fsyncAfter,
        commentCheckerAfter: guards.commentCheckerAfter,
        webfetchAfter: guards.webfetchAfter,
        rulesAfter: guards.rulesAfter,
        rulesDeleted: guards.rulesDeleted,
        modelCacheState: createModelCacheState(),
        pluginConfig: {},
      })
      await captured?.(event as never)

      // then the rule block was injected
      expect(captured).not.toBeUndefined()
      expect(event.result.content).toContain("MARKER-RULEQA")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
