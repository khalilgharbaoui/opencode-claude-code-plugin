---
title: 'Permissions'
description: 'The read-only preset, plan mode, and how AskUserQuestion is handled.'
sidebar:
  order: 5
---

## Read-only mode

```json
"options": {
  "permissionPreset": "read-only"
}
```

That is the whole configuration. The turn can read your code and search the
web, and it cannot write a file, run a command, or execute code.

Presets exist because read-only was previously a combination you had to get
exactly right. `permissionMode: "plan"` alone does not do it, and neither does
any single Claude Code flag, because this plugin puts a second execution path
next to the CLI's own tools: `proxyTools` defaults to `Bash`, `Edit`, `Write`,
`WebFetch` and `Task`, and each of those is an MCP tool the CLI calls and
**opencode** executes. No CLI flag reaches them. So the preset works at three
layers:

| Layer | What read-only does | Why it is needed |
| --- | --- | --- |
| Claude CLI tools | `--restricted` (CLI 2.1.258+) | Removes Bash, the REPL and the other code-running built-ins, removes WebFetch, confines the file tools to the working directories, and refuses bypass |
| Claude CLI tools, older CLIs | `--disallowedTools Bash Write Edit NotebookEdit REPL JavaScript WebFetch` | `--restricted` is version-gated; these names are not |
| The opencode proxy | `bash`, `write`, `edit`, `webfetch`, `task` and `task_batch` are dropped from `proxyTools` | These run in opencode, so the CLI flags above never see them |
| Everything else | `--permission-prompts none` (CLI 2.1.263+) and `controlRequestBehavior: "deny"` | A bridged MCP tool or a read outside the working directory is neither of the above |

`skipPermissions` is forced to `false`, and that is not a style choice:
`--restricted --dangerously-skip-permissions` is a startup error on CLI 2.1.280
(`Error: bypassPermissions not supported in restricted mode`), so a spawn
carrying both would not run at all.

**The preset replaces rather than merges.** Setting `skipPermissions`,
`permissionMode`, `controlRequestBehavior` or `controlRequestToolBehaviors`
next to it has no effect; each dropped value is logged at NOTICE at startup so
you can see it happen. `proxyTools` is the exception: it is filtered, so a list
naming `Question` keeps it. An unrecognised preset name applies **nothing** and
logs a WARN, rather than guessing at what you meant.

**What stops working.** Reads are fine (`Read`, `Grep`, `Glob`, `WebSearch`),
but anything that would raise a permission prompt is denied, and that includes
bridged MCP tools and the `question` proxy. Claude's own `AskUserQuestion`
still renders its stop-and-wait markdown, so the model can still ask you
things. If you need one specific tool allowed, do not use the preset: set the
underlying options yourself.

**On an older CLI** the preset still holds through `--disallowedTools` plus the
plugin's own denial of every permission request, and it warns naming what is
missing. Below 2.1.258 you lose the cwd confinement on reads; below 2.1.263 the
denial happens in the plugin rather than in the CLI, one layer instead of two.

Measured end to end on CLI 2.1.280 and `claude-haiku-4-5`: a turn under the
preset asked to write a file and run a command did neither, the file was never
created, and the CLI's own `permission_denials` recorded the single blocked
`Write` with no Bash attempt at all, because there was no Bash tool to attempt
with.

## Plan mode

Set `permissionMode: "plan"` to forward `--permission-mode plan` to Claude. The plugin handles `ExitPlanMode` specially: instead of forwarding it as a tool call, it converts it to a confirmation prompt that flows through opencode normally.

> **Plan mode never permits edits, and you do not have to configure anything for that.** The CLI lets `--dangerously-skip-permissions` override `--permission-mode plan` outright, and `skipPermissions` defaults to `true`, so until this was fixed anyone asking for plan mode silently got full write access (measured on CLI 2.1.258: the run wrote a file on request without a prompt). The plugin now drops the skip flag whenever `permissionMode` is `"plan"`; every other mode governs prompting, which is what that flag is for, so those still pass it.
>
> Two things to know. Nothing releases plan mode mid-session: headless Claude Code is not offered an `ExitPlanMode` tool, so approving a plan in chat does not unlock writes, and leaving plan mode means changing the config and restarting opencode. The plugin warns about this once at startup. And the CLI still writes its own plan document under `~/.claude*/plans/`, which is its own feature and outside your workspace; your files and commands are untouched.

By default that prompt is text: the plan is rendered as markdown, followed by `**Do you want to proceed with this plan?** (yes/no)`, and you answer in your next message.

### Approval as a real form (`planModeQuestion`, opt-in)

Set `planModeQuestion: true` to route the approval through opencode's native `question` tool instead:

```json
"options": {
  "permissionMode": "plan",
  "planModeQuestion": true
}
```

The plan is still rendered, but the turn then ends on `tool-calls` and opencode runs its own `question` tool, so approval is a form rather than prose. Your answer is fed back to the CLI as the `tool_result` for the original `ExitPlanMode` call, which is what actually unlocks plan mode on the Claude side. A "yes" typed as ordinary text never does that. Anything other than picking `yes` (including custom text) comes back as rejection feedback the model is told to act on.

> **This cannot currently fire on the default headless transport, so leaving it off costs you nothing.** The form it delivers through works (see [AskUserQuestion](#askuserquestion)), but headless `--print` does not offer the model an `ExitPlanMode` tool at all on CLI 2.1.258, and the bridge keys on that tool call. Measured three ways: asked directly for its tool list in plan mode, the CLI returned `Agent, Bash, Edit, ListAgents, Read, ReportFindings, ScheduleWakeup, Skill, ToolSearch, Workflow, Write` and nothing else; asked to do work it said "I'm unable to exit plan mode from within the tool set available to me"; and a full probe through this plugin with `planModeQuestion: true` produced no `ExitPlanMode` anywhere in `plugin.log` while the model asked for approval in prose. The name is still known to the CLI (`--disallowedTools ExitPlanMode` validates silently, where a bogus name warns), so this reads as headless dormancy rather than removal, the same shape as the [`AskUserQuestion` fallback](#askuserquestion). The text path below is what you actually get, and it works. Re-run those probes on a newer CLI before assuming the bridge is reachable. On opencode builds with no `question` registry entry the plugin silently keeps the text path (look for `plan-mode question gate` in the log).

Approval bridge contributed by [@CollieIsCute](https://github.com/CollieIsCute).

## AskUserQuestion

opencode ships a built-in `question` tool (`packages/opencode/src/tool/question.ts`) that renders a real TUI form with options and a custom-answer field, near-identical to Claude Code's `AskUserQuestion` (`multiSelect` → `multiple`). The plugin can route `AskUserQuestion` through it so the prompt becomes an actual form instead of plain text. Two modes:

### With `"Question"` in `proxyTools` (opt-in)

> **Correction, September 6, 2026: this is no longer blocked, and earlier releases of these docs were wrong about why.** The missing form was attributed to an upstream TUI regression. The real cause was local: a notification plugin awaited macOS `alerter` dismissal inside `tool.execute.before`, so the question tool never started. Native providers load that same global plugin, which is why their identical failure did not isolate the TUI. With the hook made non-blocking, the form renders, and the full path through this plugin is verified: on plugin 0.18.0 / Claude Code 2.1.258 / opencode 1.18.29, Claude called `mcp__opencode_proxy__question`, the request appeared in `GET /question`, the reply completed the tool, and Claude's answer contained a token it could only have read from the tool result. Confirmed in a real terminal too: with `"Question"` enabled and opencode relaunched, the proxied call rendered as a TUI form and the clicked answers came back into the turn.
>
> `"Question"` is still opt-in, because turning it on disables Claude's own `AskUserQuestion` (see the fallback below) and that trade should be deliberate. If your form does not render, see [a question form never renders](../troubleshooting/longer-cases.md#a-question-form-never-renders-and-the-turn-hangs) before assuming an upstream bug.

Add `"Question"` to `proxyTools`. Claude's built-in `AskUserQuestion` is disabled via `--disallowedTools`, and the plugin exposes `mcp__opencode_proxy__question` in its place. A primary agent needs no permission entry (verified on opencode 1.18.29 with no `permission` block at all); if a subagent's form is refused, grant it `permission.question: "allow"` on that agent, the same way [subagent todos](../configuration/subagents.md#subagent-todos) need `todowrite`. The model calls the proxy, opencode renders the form, and the operator's answers come back as arrays of selected labels. On builds that lack the `question` registry entry the def is silently dropped at spawn (version gate), and the deny/markdown fallback below applies instead.

`proxyTools` replaces the default list rather than adding to it, so repeat the defaults you still want:

```json
"options": {
  "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task", "Question"]
}
```

To turn it back off, drop `"Question"` from the list. It is **not** in the default list, so no configuration means the deny/markdown fallback below stays in force.

The same spawn-time caveat as `"Task"` applies: provider options are read once at opencode startup, so restart opencode fully after adding it. Question calls get a 30-minute proxy deadline (raise it with `proxyToolTimeoutMs` if you expect to be AFK longer; an expired call comes back as an error, not an answer).

### Without the proxy (default fallback)

When `"Question"` is not in `proxyTools` (or the opencode version lacks the `question` tool), the plugin handles `AskUserQuestion` as follows:

1. **It renders the full question.** The tool's payload (every question, header, option label, and option description) is emitted as readable markdown into the assistant stream so the user actually sees the choices (same approach as `ExitPlanMode`).
2. **It is never auto-allowed at the CLI gate.** Allowing it would let the headless Claude CLI resolve its own question (no TTY → fabricated/empty answer) and proceed on a guess. `controlRequestBehaviorForTool` hard-denies `AskUserQuestion` and returns a message telling the model to **stop and wait for the operator's answer**: end the turn, call no further tools, and never self-answer. (Before v0.7.0 this message also offered an "if the run is non-interactive, proceed with a reasonable guess" fallback. The model could not reliably tell interactive opencode from a headless run and routinely took it, so questions appeared to be skipped, [issue #8](https://github.com/khalilgharbaoui/opencode-claude-code-plugin/issues/8). For genuinely unattended runs, use the `controlRequestToolBehaviors` override below instead.)

This hard-deny sits **below** `controlRequestToolBehaviors` in precedence but **above** the global `controlRequestBehavior`. So:

- The global `controlRequestBehavior: "allow"` does **not** override it (interactive setups stay correct by default).
- An explicit per-tool entry **does**. For a fully unattended/automated deployment that prefers "guess and continue" over "stop and wait", restore the old auto-allow:

  ```json
  "provider": {
    "claude-code": {
      "options": {
        "controlRequestToolBehaviors": { "AskUserQuestion": "allow" }
      }
    }
  }
  ```

  With `"allow"`, the Claude CLI answers its own `AskUserQuestion` internally and the run never blocks, which is appropriate only when no operator is watching and forward progress matters more than a correct decision.
