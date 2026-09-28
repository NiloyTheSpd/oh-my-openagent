import type { Plugin } from "@opencode/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import { createEmptyTaskResponseDetectorHook } from "./hooks/empty-task-response-detector"
import { createJsonErrorRecoveryHook } from "./hooks/json-error-recovery/hook"
import { createToolOutputTruncatorHook } from "./hooks/tool-output-truncator"
import { normalizeToolArgSchemas } from "./plugin/normalize-tool-arg-schemas"
import type { ModelCacheState } from "./plugin-state"
import { createGlobTools } from "./tools/glob/tools"
import { createGrepTools } from "./tools/grep/tools"
import type { GuardFn } from "./v2-tool-guards"

type AfterInput = { tool: string; sessionID: string; callID: string }
type AfterOutput = { title: string; output: string; metadata: unknown }
type AfterFn = GuardFn

type V1Execute = (args: never, context: never) => Promise<unknown>

function toJsonSchemaInput(args: ToolDefinition["args"]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, schema] of Object.entries(args)) {
    const candidate = schema as {
      _zod?: { toJSONSchema?: () => unknown }
      isOptional?: () => boolean
    }
    if (typeof candidate._zod?.toJSONSchema !== "function") {
      throw new Error(`[v2-tools] no JSON Schema override for arg "${name}"`)
    }
    properties[name] = candidate._zod.toJSONSchema()
    if (candidate.isOptional?.() !== true) required.push(name)
  }
  return { type: "object", properties, required, additionalProperties: false }
}

export function adaptV1Tool(
  name: string,
  definition: ToolDefinition,
  directory: string,
): { name: string; description: string; input: Record<string, unknown>; execute: (input: unknown, context: { signal: AbortSignal }) => Promise<{ content: string }> } {
  normalizeToolArgSchemas(definition)
  const execute = definition.execute as unknown as V1Execute
  return {
    name,
    description: definition.description,
    input: toJsonSchemaInput(definition.args),
    execute: async (input, context) => {
      const result = await execute(input as never, { directory, signal: context.signal } as never)
      return { content: typeof result === "string" ? result : JSON.stringify(result) }
    },
  }
}

export async function registerPureToolsV2(ctx: Plugin.Context, directory: string): Promise<void> {
  const v1ctx = { directory } as unknown as PluginInput
  const tools: Record<string, ToolDefinition> = {
    ...createGrepTools(v1ctx),
    ...createGlobTools(v1ctx),
  }
  await ctx.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(tools)) {
      if (editor.get(name)) continue
      const adapted = adaptV1Tool(name, definition, directory)
      editor.add({
        name: adapted.name,
        description: adapted.description,
        input: adapted.input as { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false },
        execute: adapted.execute,
      })
    }
  })
}

export async function registerToolAfterV2Hooks(
  ctx: Plugin.Context,
  args: { fsyncAfter: AfterFn; modelCacheState: ModelCacheState },
): Promise<void> {
  const v1ctx = { directory: ctx.location.directory } as unknown as PluginInput
  const afterFns: AfterFn[] = [
    createEmptyTaskResponseDetectorHook(v1ctx)["tool.execute.after"] as unknown as AfterFn,
    createJsonErrorRecoveryHook(v1ctx)["tool.execute.after"] as unknown as AfterFn,
    args.fsyncAfter,
    createToolOutputTruncatorHook(v1ctx, { modelCacheState: args.modelCacheState })["tool.execute.after"] as unknown as AfterFn,
  ]
  await ctx.tool.hook("execute.after", async (event) => {
    // Error events carry no result text, so text guards only run on completion.
    if (event.status !== "completed") return
    if (typeof event.result.content !== "string") return
    const input: AfterInput = { tool: event.tool, sessionID: event.sessionID, callID: event.id }
    const output: AfterOutput = { title: "", output: event.result.content, metadata: {} }
    for (const guard of afterFns) {
      await guard(input, output)
    }
    event.result = { ...event.result, content: output.output }
  })
}
