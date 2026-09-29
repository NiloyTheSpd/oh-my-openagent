import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "./config"
import { createAstGrepSgProvisionHook } from "./hooks/ast-grep-sg-provision"
import { isV2HookEnabled } from "./v2-enabled"

// V1 armed this from a `session.created` event. `session.created` appears in the
// documented V2 event union but is never delivered to a plugin subscriber: it is
// emitted before plugin setup completes, so a live probe of `opencode run` captured
// zero occurrences. Provisioning therefore runs once at setup instead. The V1 hook
// still owns the dedupe and the "binary already present" check, so the work performed
// is identical -- it just no longer depends on a session event arriving.

const HOOK_NAME = "ast-grep-sg-provision"

export function registerAstGrepProvisionV2(
  _ctx: Plugin.Context,
  pluginConfig: OhMyOpenCodeConfig,
): () => void {
  if (!isV2HookEnabled(pluginConfig, HOOK_NAME)) {
    return () => {}
  }

  createAstGrepSgProvisionHook().event({ event: { type: "session.created" } })
  return () => {}
}
