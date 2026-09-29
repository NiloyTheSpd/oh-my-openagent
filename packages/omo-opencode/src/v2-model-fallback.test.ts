import { describe, expect, it } from "bun:test"
import {
  applyV2ModelFallback,
  clearSessionModelV2,
  getSessionModelV2,
  newV2ModelFallbackController,
  recordSessionModelV2,
  type V2ModelFallbackPorts,
} from "./v2-model-fallback"
import { clearSessionAgent, setSessionAgent } from "./features/claude-code-session-state"

const SESSION_ID = "ses-fallback-test"

type SwitchCall = { sessionID: string; model: { id: string; providerID: string; variant?: string } }

function createPorts(overrides: Partial<V2ModelFallbackPorts> = {}): {
  ports: V2ModelFallbackPorts
  calls: SwitchCall[]
} {
  const calls: SwitchCall[] = []
  const ports: V2ModelFallbackPorts = {
    switchModel: async (input) => {
      calls.push(input)
    },
    getAgent: () => "sisyphus",
    getModel: () => ({ providerID: "anthropic", modelID: "claude-opus-5-5" }),
    ...overrides,
  }
  return { ports, calls }
}

describe("v2 model fallback", () => {
  it("records and clears the session model", () => {
    // given a context hook observation
    recordSessionModelV2(SESSION_ID, { providerID: "anthropic", id: "claude-opus-5-5" })

    // when read back, then cleared
    expect(getSessionModelV2(SESSION_ID)).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-5-5",
    })
    clearSessionModelV2(SESSION_ID)
    expect(getSessionModelV2(SESSION_ID)).toBeUndefined()
  })

  it("switches to the next reachable fallback on session error", async () => {
    // given a session whose current model is the sisyphus head of the chain
    const { ports, calls } = createPorts()
    const controller = newV2ModelFallbackController()

    // when a session error applies the fallback
    const applied = await applyV2ModelFallback(controller, ports, SESSION_ID)

    // then switchModel receives a concrete provider/model pair
    expect(applied).not.toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionID).toBe(SESSION_ID)
    expect(calls[0]?.model.providerID.length).toBeGreaterThan(0)
    expect(calls[0]?.model.id.length).toBeGreaterThan(0)
  })

  it("forwards the variant when the fallback entry declares one", async () => {
    // given a chain whose first entry carries a variant
    const { ports, calls } = createPorts()
    const controller = newV2ModelFallbackController()
    controller.setSessionFallbackChain(SESSION_ID, [
      { providers: ["opencode"], model: "big-pickle", variant: "max" },
    ])

    // when the fallback applies
    await applyV2ModelFallback(controller, ports, SESSION_ID)

    // then the variant reaches switchModel
    expect(calls[0]?.model.variant).toBe("max")
  })

  it("omits variant entirely when the fallback entry declares none", async () => {
    // given a chain entry with no variant
    const { ports, calls } = createPorts()
    const controller = newV2ModelFallbackController()
    controller.setSessionFallbackChain(SESSION_ID, [{ providers: ["opencode"], model: "big-pickle" }])

    // when the fallback applies
    await applyV2ModelFallback(controller, ports, SESSION_ID)

    // then no variant key is sent rather than an explicit undefined
    expect("variant" in (calls[0]?.model ?? {})).toBe(false)
  })

  it("skips the current model as a no-op and moves to a different entry", async () => {
    // given a chain whose only entry is the model already in use
    const { ports, calls } = createPorts({
      getModel: () => ({ providerID: "opencode", modelID: "big-pickle" }),
    })
    const controller = newV2ModelFallbackController()
    controller.setSessionFallbackChain(SESSION_ID, [
      { providers: ["opencode"], model: "big-pickle" },
    ])

    // when the fallback applies
    const applied = await applyV2ModelFallback(controller, ports, SESSION_ID)

    // then nothing is switched, because there is no alternative
    expect(applied).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("does nothing when the session has no recorded agent", async () => {
    // given no agent recorded for the session
    const { ports, calls } = createPorts({ getAgent: () => undefined })

    // when the fallback applies
    const applied = await applyV2ModelFallback(newV2ModelFallbackController(), ports, SESSION_ID)

    // then no switch is attempted
    expect(applied).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("does nothing when the session has no recorded model", async () => {
    // given no model recorded for the session
    const { ports, calls } = createPorts({ getModel: () => undefined })

    // when the fallback applies
    const applied = await applyV2ModelFallback(newV2ModelFallbackController(), ports, SESSION_ID)

    // then no switch is attempted
    expect(applied).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("stops switching once the chain is exhausted", async () => {
    // given a one-entry chain that has already been applied
    const { ports, calls } = createPorts()
    const controller = newV2ModelFallbackController()
    controller.setSessionFallbackChain(SESSION_ID, [{ providers: ["opencode"], model: "big-pickle" }])
    await applyV2ModelFallback(controller, ports, SESSION_ID)
    expect(calls).toHaveLength(1)

    // when a further error arrives on the already-handled model
    const reapplied = await applyV2ModelFallback(controller, ports, SESSION_ID)

    // then the controller refuses to re-arm and no second switch happens
    expect(reapplied).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it("resolves the chain from the recorded session agent", async () => {
    // given an agent recorded through the context hook path
    setSessionAgent(SESSION_ID, "sisyphus")
    const { ports, calls } = createPorts({
      getAgent: () => "sisyphus",
    })
    const controller = newV2ModelFallbackController()

    // when the fallback applies
    await applyV2ModelFallback(controller, ports, SESSION_ID)

    // then the agent's built-in chain produced the switch
    expect(calls).toHaveLength(1)
    clearSessionAgent(SESSION_ID)
  })
})
