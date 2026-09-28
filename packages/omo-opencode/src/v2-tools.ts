import type { Plugin } from "@opencode/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import { createEmptyTaskResponseDetectorHook } from "./hooks/empty-task-response-detector"
import { createAgentUsageReminderHook } from "./hooks/agent-usage-reminder/hook"
import { createCategorySkillReminderHook } from "./hooks/category-skill-reminder/hook"
import { createDirectoryAgentsInjectorHook } from "./hooks/directory-agents-injector/hook"
import { createDirectoryReadmeInjectorHook } from "./hooks/directory-readme-injector/hook"
import { createEditErrorRecoveryHook } from "./hooks/edit-error-recovery/hook"
import { createJsonErrorRecoveryHook } from "./hooks/json-error-recovery/hook"
import { createReadImageResizerHook } from "./hooks/read-image-resizer/hook"
import { createTaskResumeInfoHook } from "./hooks/task-resume-info/hook"
import { createToolOutputTruncatorHook } from "./hooks/tool-output-truncator"
import { normalizeToolArgSchemas } from "./plugin/normalize-tool-arg-schemas"
import type { ModelCacheState } from "./plugin-state"
import { createGlobTools } from "./tools/glob/tools"
import { createGrepTools } from "./tools/grep/tools"
import type { GuardFn } from "./v2-tool-guards"

type AfterInput = { tool: string; sessionID: string; callID: string }
type AfterOutput = { title: string; output: string; metadata: unknown }
type AfterFn = GuardFn

import { isRecord } from "@oh-my-opencode/utils"

function titleFromInput(tool: string, input: unknown): string {
  if (tool.toLowerCase() !== "read" || !isRecord(input)) return ""
  const filePath = input.filePath ?? input.path
  return typeof filePath === "string" ? filePath : ""
}

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
  args: { fsyncAfter: GuardFn; modelCacheState: ModelCacheState },
): Promise<{ onSessionDeleted: ((sessionID: string) => void)[] }> {
  // client is a stub: V1 code uses it only as a WeakMap cache key plus live
  // session reads (which fail soft to null usage inside try/catch). A stable
  // per-setup object preserves V1 per-load cache semantics.
  const v1ctx = { directory: ctx.location.directory, client: {} } as unknown as PluginInput
  const agentsInjector = createDirectoryAgentsInjectorHook(v1ctx, args.modelCacheState)
  const readmeInjector = createDirectoryReadmeInjectorHook(v1ctx, args.modelCacheState)
  const afterFns: GuardFn[] = [
    createEmptyTaskResponseDetectorHook(v1ctx)["tool.execute.after"] as unknown as GuardFn,
    createJsonErrorRecoveryHook(v1ctx)["tool.execute.after"] as unknown as GuardFn,
    args.fsyncAfter,
    createToolOutputTruncatorHook(v1ctx, { modelCacheState: args.modelCacheState })["tool.execute.after"] as unknown as GuardFn,
    agentsInjector["tool.execute.after"] as unknown as GuardFn,
    readmeInjector["tool.execute.after"] as unknown as GuardFn,
    createAgentUsageReminderHook(v1ctx)["tool.execute.after"] as unknown as GuardFn,
    createCategorySkillReminderHook(v1ctx)["tool.execute.after"] as unknown as GuardFn,
    createReadImageResizerHook(v1ctx)["tool.execute.after"] as unknown as GuardFn,
    createEditErrorRecoveryHook(v1ctx)["tool.execute.after"] as unknown as GuardFn,
    createTaskResumeInfoHook()["tool.execute.after"] as unknown as GuardFn,
  ]
  const onSessionDeleted = [agentsInjector, readmeInjector]
    .map((hook) => hook.event)
    .filter((handler): handler is NonNullable<typeof handler> => typeof handler === "function")
    .map((handler) => (sessionID: string) => {
      void handler({ event: { type: "session.deleted", properties: { sessionID } } })
    })
  await ctx.tool.hook("execute.after", async (event) => {
    // Error events carry no result text, so text guards only run on completion.
    // Structured multi-part results have no V1 equivalent and are skipped;
    // single-text-part results are edited in place (lossless).
    if (event.status !== "completed") return
    const content = event.result.content
    let text: string | undefined
    let writeBack: ((next: string) => void) | undefined
    if (typeof content === "string") {
      text = content
      writeBack = (next) => {
        event.result = { ...event.result, content: next }
      }
    } else if (Array.isArray(content)) {
      const textParts = content.filter(
        (part): part is { text: string } =>
          typeof part === "object" && part !== null
          && (part as Record<string, unknown>).type === "text"
          && typeof (part as Record<string, unknown>).text === "string",
      )
      if (textParts.length !== 1) return
      const part = textParts[0] as { text: string }
      text = part.text
      writeBack = (next) => {
        part.text = next
      }
    } else {
      return
    }
    const input: AfterInput = { tool: event.tool, sessionID: event.sessionID, callID: event.id }
    const output: AfterOutput = {
      title: titleFromInput(event.tool, event.input),
      output: text,
      metadata: event.result.metadata ?? {},
    }
    for (const guard of afterFns) {
      await guard(input, output)
    }
    writeBack(output.output)
  })

  return { onSessionDeleted }
}
