---
title: 'Getting started'
description: 'Install the Claude Code CLI, add one line to opencode''s config, relaunch.'
sidebar:
  order: 2
---

## 1. Install and log in the Claude Code CLI

The plugin drives an existing [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code); it does not bundle one. Check that `claude` is on your `$PATH` and authenticated:

```bash
claude --version      # e.g. 2.1.263 (Claude Code)
claude auth status    # which account you are signed in as
claude auth login     # run this if you are not signed in yet
```

`login`, `status` and `logout` are the `claude auth` subcommands as of 2.1.263. Run `claude auth --help` if your install differs.

## 2. Add the plugin to your opencode config

opencode reads a global config at `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME/opencode/` when that is set). A project-level `opencode.json` in your repo overrides the global one, and `OPENCODE_CONFIG=/path/to/config.json` points opencode at one specific file instead. Put the plugin in the global config so every project gets it:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"]
}
```

That package spec is the whole install. Do **not** `npm install` the package yourself: opencode resolves and caches plugin packages on its own. You do not need a `provider` block either, unless you want to change one of the [options](./configuration/options.md).

## 3. Restart opencode and verify

Quit opencode fully and relaunch it: plugins are loaded once, at process start, so a reload is not enough.

In the model picker you should now see a provider called **Claude Code (Default)** holding entries such as `Claude Haiku 4.5 (1×)`, `Claude Sonnet 5.5 (2×)` and `Claude Opus 5 (5×)`. The `(N×)` suffix is each model's list price relative to Haiku; see [Models](./models.md). Pick one and send a message.

If the provider does not appear, if the models are there but a message fails, or if a version you just upgraded to is missing, go to [Troubleshooting](./troubleshooting/symptoms.md). It is keyed on the first thing you see and names one check per symptom.

Building from a checkout instead? See [Development](./internals/development.md).
