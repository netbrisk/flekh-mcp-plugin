# Flekh plugin for Claude Code

[Flekh](https://www.flekh.com) is video review, approval and publishing for teams, agencies and their AI agents.
This plugin connects Claude Code to the Flekh MCP server (`https://api.flekh.com/mcp`) and adds a skill for the
review loop: upload a render, share the link, read frame-accurate comments, upload the next version, reply and
resolve, until it is approved.

## Install

In Claude Code:

```
/plugin marketplace add netbrisk/flekh-mcp-plugin
/plugin install flekh@flekh
```

Then run `/mcp`, choose **flekh** and sign in with your Flekh account.

Or, from any terminal (Claude Code, Cursor and Codex in one go):

```bash
npx -y @flekh/review setup
```

Claude apps (claude.ai, Desktop, mobile): Settings › Connectors › add a custom connector with
`https://api.flekh.com/mcp`.

Help: https://help.flekh.com/en/articles/connect-claude-chatgpt-or-cursor-to-flekh-mcp

## Try it

> render the intro and upload it to Flekh for the Acme project

> read the comments on Summer teaser, fix them and upload v3

What an agent may approve, schedule or publish is set per project in Flekh (Agents settings).

## What's inside

| Path | What |
| --- | --- |
| `.claude-plugin/marketplace.json` | Marketplace `flekh` with one plugin |
| `plugins/flekh/.claude-plugin/plugin.json` | Plugin manifest |
| `plugins/flekh/.mcp.json` | Flekh MCP server (HTTP, OAuth sign-in) |
| `plugins/flekh/skills/video-review/SKILL.md` | The review loop skill |
| `server.json` | Entry for the official MCP Registry (`io.github.netbrisk/flekh`) |
| `.github/workflows/publish-mcp.yml` | Publishes `server.json` to the registry (GitHub OIDC) when it changes on `main` |

## Release

- Plugin: bump `version` in `plugins/flekh/.claude-plugin/plugin.json`, push to `main`.
- MCP Registry: bump `version` in `server.json`, push to `main` (the workflow publishes it; the registry refuses a
  version it already has).

## License

MIT, see [LICENSE](LICENSE).
