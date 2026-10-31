/**
 * A subagent's model chosen per call (src/task-model.ts, h #g254): reading
 * opencode 2's `providerID/modelID#variant` reference, the `accountGroups`
 * rule a per-call model must pass, and the records that carry an explicit
 * request from the parent's `task` call into the child's own prologue.
 *
 * Usage: npx tsx --test test/task-model.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { accountProviderMap } from "../src/account-groups.js"
import { isRegisteredModelName } from "../src/agent-models.js"
import {
  _resetTaskModelForTests,
  claimExplicitTaskModel,
  completeTaskModelReference,
  explicitTaskModelApplies,
  explicitTaskModelFor,
  forgetExplicitTaskModel,
  hasExplicitTaskModelCandidate,
  noteExplicitTaskModels,
  parseTaskModelReference,
  taskModelAccountRefusal,
} from "../src/task-model.js"

const PARENT = "ses_parent"
const CHILD = "ses_child"
const WRAPPED = (prompt: string) => `You are a subagent spawned by another session.\n${prompt}`

test("a reference splits into provider, model and variant, as opencode 2 writes it", () => {
  assert.deepEqual(parseTaskModelReference("claude-code/claude-opus-5-5"), {
    providerID: "claude-code",
    modelID: "claude-opus-5-5",
  })
  assert.deepEqual(parseTaskModelReference("claude-code-work/claude-opus-5-5@work#high"), {
    providerID: "claude-code-work",
    modelID: "claude-opus-5-5@work",
    variant: "high",
  })
  // A model id may itself hold a slash; only the provider may not.
  assert.deepEqual(parseTaskModelReference(" openrouter/anthropic/claude-sonnet-4.5 "), {
    providerID: "openrouter",
    modelID: "anthropic/claude-sonnet-4.5",
  })
})

test("anything that is not a reference parses to null, for opencode to reject itself", () => {
  for (const value of [
    "claude-opus-5-5",
    "/claude-opus-5-5",
    "claude-code/",
    "claude-code/opus#high#low",
    "claude-code#x/opus",
    "",
    42,
    undefined,
    { providerID: "claude-code" },
  ]) {
    assert.equal(parseTaskModelReference(value), null, JSON.stringify(value))
  }
})

test("a bare model id is completed to this conversation's own provider and account (h #g255)", () => {
  const single = { providerID: "claude-code", isRegistered: isRegisteredModelName }
  assert.equal(completeTaskModelReference("claude-sonnet-5-5", single), "claude-code/claude-sonnet-5-5")
  assert.equal(completeTaskModelReference(" claude-sonnet-5-5#high ", single), "claude-code/claude-sonnet-5-5#high")
  assert.equal(
    completeTaskModelReference("claude-opus-5-5-fast", single),
    "claude-code/claude-opus-5-5-fast",
    "a fast id is a registered id like any other",
  )

  // The default account of a multi-account install serves its ids unmarked.
  const defaultAccount = { providerID: "claude-code-default", isRegistered: isRegisteredModelName }
  assert.equal(completeTaskModelReference("claude-sonnet-5-5", defaultAccount), "claude-code-default/claude-sonnet-5-5")

  const work = { providerID: "claude-code-work", accountMarker: "work", isRegistered: isRegisteredModelName }
  assert.equal(completeTaskModelReference("claude-sonnet-5-5", work), "claude-code-work/claude-sonnet-5-5@work")
  assert.equal(
    completeTaskModelReference("claude-sonnet-5-5@work#max", work),
    "claude-code-work/claude-sonnet-5-5@work#max",
    "the conversation's own marker is the same reading",
  )
})

test("only that one reading is completed; everything else reaches opencode as written", () => {
  const work = { providerID: "claude-code-work", accountMarker: "work", isRegistered: isRegisteredModelName }
  for (const value of [
    "claude-code/claude-sonnet-5-5",
    "anthropic/claude-sonnet-5-5",
    "openrouter/anthropic/claude-sonnet-4.5",
    "claude-sonnet-5-5@private",
    "claude-sonnet-5-5@",
    "claude-sonnet-5.5",
    "gpt-5",
    "claude-sonnet-5-5#",
    "claude-sonnet-5-5#high#max",
    "",
    "   ",
  ]) {
    assert.equal(completeTaskModelReference(value, work), value, `"${value}" is left alone`)
  }
  for (const value of [undefined, null, 42, { id: "claude-sonnet-5-5" }]) {
    assert.equal(completeTaskModelReference(value, work), value)
  }
  assert.equal(
    completeTaskModelReference("claude-sonnet-5-5@work", { providerID: "claude-code-default", isRegistered: isRegisteredModelName }),
    "claude-sonnet-5-5@work",
    "the default account has no marker, so any marker names another account",
  )
})

test("the account guard refuses a model on an account in another group, and nothing else", () => {
  const providers = accountProviderMap(["default", "work", "private"])
  const groups = { work: "job" }
  const ask = (model: unknown, extra: Partial<Parameters<typeof taskModelAccountRefusal>[0]> = {}) =>
    taskModelAccountRefusal({ model, sourceAccount: "default", providers, groups, crossGroup: false, ...extra })

  const refusal = ask("claude-code-work/claude-opus-5-5@work#high")
  assert.ok(refusal)
  assert.match(refusal, /"work"/)
  assert.match(refusal, /no tasks were started/)

  assert.equal(ask("claude-code-private/claude-opus-5-5@private"), null, "same implicit group")
  assert.equal(ask("claude-code-default/claude-haiku-4-5@default"), null, "the caller's own account")
  assert.equal(ask("openai/gpt-5#high"), null, "not one of this plugin's accounts")
  assert.equal(ask("claude-code/claude-opus-5-5"), null, "the single-account provider is no account here")
  assert.equal(ask("not a reference"), null, "opencode answers a bad reference itself")
  assert.equal(ask("claude-code-work/claude-opus-5-5@work", { crossGroup: true }), null)
  assert.equal(ask("claude-code-work/claude-opus-5-5@work", { groups: null }), null, "no guard unless set")
  assert.ok(
    ask("claude-code-default/claude-opus-5-5@default", { sourceAccount: "work" }),
    "the rule runs both ways: from the work group, the default group is refused too",
  )
})

test("a fresh child takes its parent's explicit model by agent and first message, once", () => {
  _resetTaskModelForTests()
  const noted = noteExplicitTaskModels(PARENT, [
    { description: "a", prompt: "Build the parser.", subagent_type: "implementor", model: "claude-code/claude-opus-5-5#high" },
    { description: "b", prompt: "Draw the screen.", subagent_type: "designer" },
  ])
  assert.equal(noted, 1, "only the task that named a model")
  assert.equal(hasExplicitTaskModelCandidate("implementor", WRAPPED("Build the parser.")), true)
  assert.equal(hasExplicitTaskModelCandidate("designer", "Draw the screen."), false)
  assert.equal(hasExplicitTaskModelCandidate("implementor", "Something else."), false)

  assert.equal(
    claimExplicitTaskModel({ sessionId: CHILD, agent: "implementor", prompt: "Build the parser.", parentSessionId: "ses_other" }),
    undefined,
    "a session that is not the dispatcher's child can never take it",
  )
  const claimed = claimExplicitTaskModel({
    sessionId: CHILD,
    agent: "implementor",
    prompt: WRAPPED("Build the parser."),
    parentSessionId: PARENT,
  })
  assert.deepEqual(claimed, { providerID: "claude-code", modelID: "claude-opus-5-5", variant: "high" })
  assert.deepEqual(explicitTaskModelFor(CHILD), claimed, "held for the child's later turns")
  assert.equal(hasExplicitTaskModelCandidate("implementor", "Build the parser."), false, "consumed")

  forgetExplicitTaskModel(CHILD)
  assert.equal(explicitTaskModelFor(CHILD), undefined)
})

test("an exact prompt beats a wrapped one, so a verbatim child keeps its own claim", () => {
  _resetTaskModelForTests()
  noteExplicitTaskModels(PARENT, [
    { prompt: "first line\nBuild it.", subagent_type: "general", model: "claude-code/claude-sonnet-5-5" },
    { prompt: "Build it.", subagent_type: "general", model: "claude-code/claude-opus-5-5" },
  ])
  const verbatim = claimExplicitTaskModel({ sessionId: "ses_a", agent: "general", prompt: "Build it.", parentSessionId: PARENT })
  assert.equal(verbatim?.modelID, "claude-opus-5-5")
  const wrapped = claimExplicitTaskModel({ sessionId: "ses_b", agent: "general", prompt: "first line\nBuild it.", parentSessionId: PARENT })
  assert.equal(wrapped?.modelID, "claude-sonnet-5-5")
})

test("a resumed child is named by its own id, needs no parent and no claim", () => {
  _resetTaskModelForTests()
  noteExplicitTaskModels(undefined, [
    { prompt: "Carry on.", subagent_type: "general", task_id: "ses_resumed", model: "claude-code/claude-opus-5-5" },
  ])
  assert.equal(explicitTaskModelFor("ses_resumed")?.modelID, "claude-opus-5-5")
  noteExplicitTaskModels(undefined, [
    { prompt: "Now cheaper.", task_id: "ses_resumed", model: "claude-code/claude-haiku-4-5#low" },
  ])
  assert.deepEqual(explicitTaskModelFor("ses_resumed"), {
    providerID: "claude-code",
    modelID: "claude-haiku-4-5",
    variant: "low",
  }, "the newest request replaces the older one")
})

test("nothing is recorded without a model, or for a fresh child with no real parent", () => {
  _resetTaskModelForTests()
  assert.equal(noteExplicitTaskModels(PARENT, [{ prompt: "x", subagent_type: "general" }]), 0)
  assert.equal(noteExplicitTaskModels(PARENT, [{ prompt: "x", model: "" }]), 0)
  assert.equal(noteExplicitTaskModels("default", [{ prompt: "x", model: "claude-code/claude-opus-5-5" }]), 0)
  assert.equal(noteExplicitTaskModels(undefined, [{ prompt: "x", model: "claude-code/claude-opus-5-5" }]), 0)
  assert.equal(hasExplicitTaskModelCandidate("general", "x"), false)
})

test("an unclaimed request expires, so a later unrelated child cannot take it", () => {
  _resetTaskModelForTests()
  const then = 1_000_000
  noteExplicitTaskModels(PARENT, [{ prompt: "Late.", subagent_type: "general", model: "claude-code/claude-opus-5-5" }], then)
  assert.equal(hasExplicitTaskModelCandidate("general", "Late.", then + 60_000), true)
  assert.equal(hasExplicitTaskModelCandidate("general", "Late.", then + 16 * 60_000), false)
})

test("a record applies only while the child runs on exactly the model it names", () => {
  const record = { providerID: "claude-code-work", modelID: "claude-opus-5-5@work", variant: "high" }
  assert.equal(explicitTaskModelApplies(record, "claude-opus-5-5@work"), true)
  assert.equal(explicitTaskModelApplies(record, "claude-opus-5-5"), false, "another account's copy")
  assert.equal(explicitTaskModelApplies(record, "claude-sonnet-5-5@work"), false)
  assert.equal(explicitTaskModelApplies(undefined, "claude-opus-5-5@work"), false)
})
