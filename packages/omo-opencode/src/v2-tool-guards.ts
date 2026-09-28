import type { Plugin } from "@opencode/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import { isRecord } from "@oh-my-opencode/utils"
import { log, replaceToolArgs } from "./shared"
import { createFsyncSkipWarningHook } from "./hooks/fsync-skip-warning/index"
import { createWriteExistingFileGuardHook } from "./hooks/write-existing-file-guard/hook"
import { createNotepadWriteGuardHook } from "./hooks/notepad-write-guard/index"
import { createPrometheusMdOnlyHook } from "./hooks/prometheus-md-only/hook"
import { createQuestionLabelTruncatorHook } from "./hooks/question-label-truncator/hook"

type BeforeInput = { tool: string; sessionID: string; callID: string }
export type GuardFn = (
  input: { tool: string; sessionID: string; callID: string },
  output: Record<string, unknown>,
) => Promise<void>

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function stripMcpPrefix(tool: string): string {
  return tool.replace(/^mcp_/i, "")
}

export async function registerToolGuardV2Hooks(ctx: Plugin.Context): Promise<{
  fsyncAfter: GuardFn
}> {
  // The write guard only reads ctx.directory; the other two factories take no args.
  const v1ctx = { directory: ctx.location.directory } as unknown as PluginInput
  // fsync timing state must be shared between its before/after halves.
  const fsync = createFsyncSkipWarningHook()
  const guardFns: GuardFn[] = [
    createWriteExistingFileGuardHook(v1ctx)["tool.execute.before"] as unknown as GuardFn,
    createNotepadWriteGuardHook()["tool.execute.before"] as unknown as GuardFn,
    createQuestionLabelTruncatorHook()["tool.execute.before"] as unknown as GuardFn,
    createPrometheusMdOnlyHook(v1ctx)["tool.execute.before"] as unknown as GuardFn,
    fsync["tool.execute.before"] as unknown as GuardFn,
  ]

  await ctx.tool.hook("execute.before", async (event) => {
    const input: BeforeInput = {
      tool: event.tool,
      sessionID: event.sessionID,
      callID: event.id,
    }
    const output: Record<string, unknown> = { args: asRecord(event.input) }

    if (/^mcp_/i.test(input.tool)) {
      const stripped = stripMcpPrefix(input.tool)
      log("[tool-execute-before] Stripped mcp_ prefix from tool name", {
        original: input.tool,
        resolved: stripped,
        sessionID: input.sessionID,
        callID: input.callID,
      })
      input.tool = stripped
    }

    const args = output.args
    if (input.tool.toLowerCase() === "bash" && isRecord(args) && typeof args.command === "string") {
      if (args.command.includes("\x00")) {
        replaceToolArgs(output as { args: Record<string, unknown> }, { command: args.command.replace(/\x00/g, "") })
        log("[tool-execute-before] Stripped null bytes from bash command", {
          sessionID: input.sessionID,
          callID: input.callID,
        })
      }
    }

    for (const guard of guardFns) {
      await guard(input, output)
    }

    event.tool = input.tool
    event.input = (output as { args: Record<string, unknown> }).args
  })

  return { fsyncAfter: fsync["tool.execute.after"] as unknown as GuardFn }
}
