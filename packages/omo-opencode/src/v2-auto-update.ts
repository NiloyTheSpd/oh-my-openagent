import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "./config"
import { createAutoUpdateCheckerHook } from "./hooks/auto-update-checker"
import { log } from "./shared/logger"
import { isV2HookEnabled } from "./v2-enabled"

// V1 armed this from a `session.created` event, which the V2 server never delivers
// to a plugin subscriber (it is emitted before plugin setup finishes), so the check
// runs once at setup instead.
//
// Seven of the eight V1 dependencies reach for `ctx.client`, and every one of them
// is a `tui.showToast` call except `updateAndShowConnectedProvidersCacheStatus`, which
// reads connected providers through the V1 client. V2 exposes no toast and no client
// on `Plugin.Context`, so those are replaced with the log-only stubs below. The parts
// that carry real work -- local-dev detection, the model-capability cache refresh, and
// the background npm update check -- are V1's own implementations, reused unchanged.

const HOOK_NAME = "auto-update-checker"

const notAvailableInV2 = (name: string) => async (): Promise<void> => {
  log("[v2-auto-update-checker] skipped: no V2 equivalent", { dependency: name })
}

type V1HookFactory = typeof createAutoUpdateCheckerHook

export function registerAutoUpdateCheckerV2(
  ctx: Plugin.Context,
  pluginConfig: OhMyOpenCodeConfig,
  createHook: V1HookFactory = createAutoUpdateCheckerHook,
): () => void {
  if (!isV2HookEnabled(pluginConfig, HOOK_NAME)) {
    return () => {}
  }

  const v1ctx = { directory: ctx.location.directory, client: {} } as never
  const hook = createHook(v1ctx, {}, {
    showConfigErrorsIfAny: notAvailableInV2("showConfigErrorsIfAny"),
    updateAndShowConnectedProvidersCacheStatus: notAvailableInV2(
      "updateAndShowConnectedProvidersCacheStatus",
    ),
    showModelCacheWarningIfNeeded: notAvailableInV2("showModelCacheWarningIfNeeded"),
    showLocalDevToast: notAvailableInV2("showLocalDevToast"),
    showVersionToast: notAvailableInV2("showVersionToast"),
  } as never)

  hook.event({ event: { type: "session.created" } })
  return () => {}
}
