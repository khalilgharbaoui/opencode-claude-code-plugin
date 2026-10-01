---
title: 'Skills'
description: 'The bundled configuration skill, and bridging your opencode skills into Claude''s native Skill tool.'
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

No separate skill installation or copying is needed. It ships with each package version, so upgrading updates the reference. Fully restart opencode to load it. `test-configure-skill.ts` checks coverage of provider/logging options, model ids, proxy tools and environment variables; maintainers must update behavior and default guidance in the same change as the implementation.

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
