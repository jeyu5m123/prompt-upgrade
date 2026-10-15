# Prompt Upgrade

A [Claude Code](https://code.claude.com/docs) mod that adds one slash command: `/better`.

It takes a rough prompt, asks you a few quick questions about what you actually want, rewrites it, and shows the before/after side by side. Nothing runs until you press **Run**.

## Install

In a Claude Code session:

```
/plugin marketplace add jeyu5m123/prompt-upgrade
/plugin install prompt-upgrade@prompt-upgrade
```

Or from your shell:

```bash
claude plugin marketplace add jeyu5m123/prompt-upgrade
claude plugin install prompt-upgrade@prompt-upgrade
```

Already in a session? Run `/reload-plugins` to load it, otherwise it loads next time you start Claude Code.

Needs Claude Code **v2.1.287 or later** (v2.1.286 in the Desktop app) because it is a mod. Check with `claude --version`.

## Use

| Command | What it does |
| --- | --- |
| `/better <prompt>` | Opens the upgrade pane for that prompt |
| `/better` | Opens a blank pane so you can type the prompt inside it |
| `/better on` | Automatic mode: prompts you type open in the pane first |
| `/better off` | Automatic mode off: prompts go straight through |
| `/better history` | Opens your last upgrades |

In automatic mode you can type `>` to send a prompt as is.

## What is in here

```
.claude-plugin/marketplace.json   the catalog Claude Code reads
plugins/prompt-upgrade/           the plugin (a mod) itself
  .claude-plugin/plugin.json      manifest
  hooks/hooks.json                points at the hooks module
  hooks/register.tsx              the mod: registers /better and draws the pane
  hooks/logic.ts                  questions, rewrite, scoring
  tests/                          claude plugin test
```

## Trust

A mod is code that runs with your permissions. This one registers a command, draws a pane, stores your upgrade history in the plugin's own store, calls a model to do the rewrite, and submits the finished prompt as your own when you press **Run**. Read `plugins/prompt-upgrade/hooks/register.tsx` before installing, or check it without running it:

```bash
claude plugin validate ./plugins/prompt-upgrade
```

## License

MIT
