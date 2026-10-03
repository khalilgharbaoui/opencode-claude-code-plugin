---
title: 'Longer cases'
description: 'Nothing in the picker, a question form that never renders, and a proxy call that will not finish.'
sidebar:
  order: 2
---

## Nothing in the picker, or a version you just upgraded to is missing

The plugin's own startup line separates "never loaded" from "loaded and misconfigured":

```bash
OPENCODE_CLAUDE_CODE_LOG_FILE=1 opencode
grep "plugin ready" ~/.local/share/opencode-claude-code/plugin.log
```

One `NOTICE: claude-code plugin ready` entry per process reports the plugin version, the `claude` binary and version it found, the directory it will spawn in, and which providers registered. [Startup diagnostics](../configuration/logging.md#startup-diagnostics) explains every field, and `/claude-code-doctor` prints the same fields plus live process state without enabling the log at all.

**No line.** The plugin did not load. Confirm the package spec is in `plugin` (opencode 1.x) or `plugins` (2.x), that a local checkout points at the repository root on 1.x and at `dist/` on 2.x, and that you fully relaunched: plugins are loaded once, at process start.

**A line naming an older version.** That is opencode's package cache. It resolves the `@latest` spec once and freezes the concrete version, so restarting never re-resolves the tag. Delete the entry and relaunch:

```bash
rm -rf ~/.cache/opencode/packages/@khalilgharbaoui/opencode-claude-code-plugin@latest
```

A `file://` install is different: it runs the checkout's `dist/`, so rebuild with `npm run build` and restart rather than deleting anything.

**`claudeCli.version` reading `not detected`.** The binary at that path did not answer `--version`, which also silently disables every version-gated flag, including `--thinking-display summarized`, `--plugin-dir` and the fast-mode opt-in.

## A fix you installed is not taking effect

opencode reads a plugin's code once, when the process starts, and never again. A window that has been open since before you upgraded is still running the build it loaded then, and every other signal you can check (`npm ls`, the registry, `git log`, the files on disk) agrees with the new version. On 2026-10-03 that cost a live debugging session here: an account-failover answer behaved exactly like a defect fixed three weeks earlier, because the window answering it had been open for eleven days. Ten opencode processes were running at the time.

The plugin now says so itself, in two places:

- **One note in the reply**, once per conversation, led by `▌ **restart opencode:**`. It names the version this process loaded, when it loaded it, and the version on disk. It is written before Claude's own output, counts as nothing the model said, and is stripped from any transcript rebuilt for the CLI.
- **The `plugin build` row of `/claude-code-doctor`**, which re-reads the disk every time you run it:

| The row says | What it means |
|---|---|
| `0.36.5, loaded 2026-10-03 09:12, current` | This process is running the build on disk. |
| `… ; on disk 0.36.5. Restart opencode to run it` | A different version is installed. Quit every opencode window and relaunch. |
| `… ; the same version was rebuilt on disk at 2026-10-03 14:21. Restart opencode to run it` | A `file://` install whose `dist/` was rebuilt without a version bump. Same fix. |
| `… ; the build on disk could not be read` | Not a verdict. A package cache mid-reinstall, a build mid-`clean` or an unreadable path all land here, and none of them is evidence that this process is stale. |

The fix is always the same, and "restart" means the process, not the session: quit every opencode window, including `serve` and GUI processes, and relaunch. A `/new` session reuses the same process and changes nothing.

## A question form never renders and the turn hangs

For a stalled call, inspect `GET /question` on the same opencode server and workspace. If no request exists, check awaited `tool.execute.before` hooks and custom tools replacing `question`, especially notification plugins: a hook opencode waits on runs *before* the tool, so the request cannot exist yet. If a request exists but no form appears, check session ownership, pending permissions, and event delivery. The separate detach/reattach issue [anomalyco/opencode#36604](https://github.com/anomalyco/opencode/issues/36604) remains open; [PR #36603](https://github.com/anomalyco/opencode/pull/36603) is closed without merging. Do not infer a universal platform or version failure from either symptom.

## A proxy call that will not finish

A proxied call ends on an event rather than a clock ([how a proxied call ends](../internals/how-a-proxied-call-ends.md)), so three log lines exist to keep the waiting visible. **None of them is a failure, and none of them ends a call:**

- `proxy call still waiting, no deadline`, at WARN, five minutes in and every five minutes after, naming the tool, the call id, how long it has waited and what will end it. `task` and `task_batch` have no deadline by default, so this is exactly what a healthy long-running subagent looks like.
- `proxy call still waiting, deadline approaching`, once, at 60% of a deadline that does exist, carrying the time remaining and naming the option that would extend it. Deadlines under a minute are not announced at all.
- `proxy call past its deadline, but opencode is still serving it; waiting`, when the deadline passed while opencode reported the session busy: most often a permission prompt nobody has answered yet. It is rechecked every minute.

`/claude-code-doctor` lists the same calls on demand, with ages and deadlines. Use it to tell a working subagent from a wedged one *before* changing any timeout, and read [per-tool proxy timeouts](../guides/tool-proxy.md#per-tool-proxy-timeouts) before setting one.
