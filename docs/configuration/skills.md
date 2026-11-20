---
title: 'Skills'
description: 'The bundled configuration skill, your Claude Code commands and skills in opencode''s / menu, and bridging your opencode skills into Claude''s native Skill tool.'
sidebar:
  order: 7
---

## Configuration skill

The package includes a `claude-code-plugin` skill so your agent can configure it without asking you to navigate all its options. Ask, for example:

```text
Use the claude-code-plugin skill to configure a work account and idle worker cleanup.
```

It covers accounts, models and agent effort, proxy tools, permissions, MCP/skill bridging, timeouts, logging, upgrades and troubleshooting. It directs the agent to preserve JSONC comments, change only requested settings, validate the result, protect credentials and ask before paid probes or broader permissions.

The plugin registers the bundled directory with opencode's `skills.paths`, making it available to other providers too on supporting opencode versions. For Claude turns it also loads through Claude's native Skill tool as `opencode-skills:claude-code-plugin`, even when `bridgeOpencodeSkills` is `false`. This requires CLI `--plugin-dir` support and applies to the headless and interactive spawns; compaction never loads the native bridge.

No separate skill installation or copying is needed. It ships with each package version, so upgrading updates the reference. Fully restart opencode to load it. `test/configure-skill.test.ts` checks coverage of provider/logging options, model ids, proxy tools and environment variables; maintainers must update behavior and default guidance in the same change as the implementation.

## Claude Code's own commands and skills in the `/` menu

Your Claude Code commands and skills work in opencode. The plugin lists them in opencode's `/` menu, each described as `Claude Code: ...`, and picking one sends it to Claude Code, which runs it as a command. Typing one works too. The list covers:

- your own, from your Claude config dir's `commands/` and `skills/`;
- the project's, from `.claude/commands` and `.claude/skills` in the folder or above it, up to the git root;
- every enabled Claude Code plugin's, such as `/stripe:test-cards` or `/appical-core:release`;
- the skills Claude Code syncs for your account.

A plugin skill is listed under its short name when that is unique: `/release` for `appical-core:release`, or under `plugin:name` when two plugins share it. Claude Code's built-in commands (`/model`, `/compact`, `/cost` and the rest) are never listed. Neither is a name opencode already has: opencode's own commands (`/init`, `/review`, `/models`, `/status` and so on), the commands you defined in opencode and the plugin's `/btw` and `/claude-code-doctor` always win.

Typing a short name works even before the menu lists it. Claude Code itself accepts a plugin skill only under its full name when it runs headless, so the plugin sends `/release planned` as `/appical-core:release planned` when exactly one enabled plugin defines `release` and nothing of yours, of the project or of Claude Code is called `release`. A name that is ambiguous or unknown is sent exactly as you typed it.

```text
/test-cards declined      runs the stripe plugin's test-cards skill
/release planned          runs appical-core:release, if it is the only release
/hello-probe              runs .claude/commands/hello-probe.md
```

How the list is read: when opencode starts, a short background `claude` is asked for its commands (it gets one `initialize` request and no message, with hooks and MCP servers off), once per folder and per configured account, and the answer is kept in `$XDG_STATE_HOME/opencode-claude-code-plugin/claude-commands.json`. Measured on Claude Code 2.1.322: about a second and no API request. opencode reads its `/` menu when it starts, so the menu shows the list from the previous start, and a command or skill you install while opencode runs is listed from the next start. On opencode 2, `/reload` asks again too, and a second `/reload` lists what the first one found. A typed command works as soon as the background `claude` has seen it.

The menu is shared by every model, so an entry picked in a session on another provider reaches that model as plain text: the `Claude Code:` description is the reminder. The interactive transport types the command into Claude Code's own input, and gets the full name too. Turn all of this off with `claudeCommands: false`; `OPENCODE_CLAUDE_CODE_COMMAND_PROBE=0` stops only the background `claude`.

## Skill bridge

opencode and Claude Code use the same on-disk skill format, a `<name>/SKILL.md` whose frontmatter carries `name` and `description`, but they read from overlapping, not identical, directories. opencode looks in `.opencode/skills/`, `~/.config/opencode/skills/`, `~/.agents/skills/` and more; the Claude CLI looks in `~/.claude/skills/`, the project's `.claude/skills/` and its own plugins. Where they differ, opencode advertises a skill in the system prompt it forwards, the model calls `Skill("browser-automation")`, and Claude answers `Unknown skill`. Where they overlap, the same skill reaches one session twice.

By default the plugin discovers your opencode skills, stages a throwaway Claude Code plugin directory that links them, and passes it as `claude --plugin-dir`. They register natively, prefixed with the plugin name:

```text
opencode-skills:browser-automation
opencode-skills:rtk
```

Claude can invoke them with the Skill tool or as `/opencode-skills:<name>`. `--plugin-dir` is scoped to the spawned session, so nothing is written into your `~/.claude`.

Discovery covers every root opencode itself reads, first match wins:

1. Walking up from the working directory: `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` at each level.
2. `~/.opencode/skills/`.
3. `$OPENCODE_CONFIG_DIR/skills/` and `.../skill/`.
4. `~/.config/opencode/skills/` and `.../skill/` (or `$XDG_CONFIG_HOME`).
5. `~/.claude/skills/` and `~/.agents/skills/`.

A project skill shadows a global one of the same name, and an opencode-managed copy shadows an external one. Step 5 is opencode's own "external" scan and honours its `OPENCODE_DISABLE_EXTERNAL_SKILLS` and `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` variables. A skill is known by the `name:` its `SKILL.md` frontmatter declares, falling back to the directory name, which is what opencode advertises. If the skill set is unchanged the staged directory is reused between spawns.

### Skills Claude already has

Those roots overlap Claude Code's own, which reads `$CLAUDE_CONFIG_DIR/skills/` (`~/.claude/skills/` by default), the project's `.claude/skills/`, and the `skills/` folder of every installed plugin. Without care one skill reaches a single session twice, costing prompt tokens on every turn and leaving it ambiguous which copy answers.

So `bridgeSkipNativeSkills` (**on by default**) leaves a skill unbridged when Claude already loads it. A skill counts as already loaded when:

- it is literally the same directory, symlinks resolved;
- its `SKILL.md` is byte-identical to a native one, wherever that one lives (this is the case for a skill installed as a Claude plugin *and* symlinked into `~/.agents/skills`);
- a **different** skill of the same name is registered under user or project scope. Plugin skills are namespaced `<plugin>:<name>` and so never take a bridged name, only duplicate its content.

Only that last case changes which copy answers `Skill("<name>")`, so it is logged at WARN naming both paths; the others are logged at INFO. Set `bridgeSkipNativeSkills: false` to bridge everything regardless and get the duplicates back.

One limitation worth knowing: the plugin scan reads `installed_plugins.json` and does not check whether that plugin is actually enabled, so a skill from a disabled plugin can be treated as native. If a skill disappears, grep `plugin.log` for `skills claude code already loads`: one line names both paths and the reason.

### Enabling it

The bridge itself is **off by default**: every bridged skill's name and description is also in the system prompt opencode already forwards, so a large skill set is paid for twice on every turn. Set `bridgeOpencodeSkills: true` when the model tries `Skill("<name>")` for a skill opencode advertises and gets `Unknown skill`; the bundled configuration skill is staged either way. When on, the bridge applies to the headless and interactive spawns alike, never to compaction, and it is skipped on a Claude CLI without `--plugin-dir` (the plugin probes `claude --help` and logs a notice).

This bridge was written by [@broskees](https://github.com/broskees) (Joseph Roberts) on his fork and absorbed here with credit; see [Credits](../credits.md).
