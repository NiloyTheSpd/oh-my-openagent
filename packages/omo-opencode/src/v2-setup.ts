import { Plugin } from "@opencode/plugin"
import { initConfigContext } from "./cli/config-manager/config-context"
import { validatePluginConfig } from "./config/validate"
import { migrateLegacyWorkspaceDirectory } from "./shared/legacy-workspace-migration"
import { log } from "./shared/logger"
import { registerSessionV2Hooks } from "./v2-session"

export async function setupV2(ctx: Plugin.Context): Promise<void> {
  const directory = ctx.location.directory
  initConfigContext("opencode", null)
  migrateLegacyWorkspaceDirectory(directory)
  const validation = validatePluginConfig(directory)
  log("[oh-my-openagent] v2 setup booted", {
    directory,
    valid: validation.valid,
  })
  await registerSessionV2Hooks(ctx)
}
