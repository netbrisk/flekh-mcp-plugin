# @flekh/review

Connect [Flekh](https://flekh.com) to the AI tools on your computer, and upload files from your computer to Flekh
from Claude Code or any AI agent with a terminal.

## Setup

```bash
npx -y @flekh/review setup
```

Adds the Flekh MCP server (`https://api.flekh.com/mcp`) to every tool it finds, then signs you in:

- **Claude Code** (if `claude` is installed): `claude mcp add --scope user --transport http flekh …`, so Flekh is in
  every project. Signs in with `claude mcp login flekh`, or on older versions run `/mcp` in Claude Code and pick flekh.
- **Cursor** (if `~/.cursor` exists): adds `flekh` to `~/.cursor/mcp.json` and keeps your other servers. If that file
  isn't valid JSON it is left alone and you get the line to add yourself. Cursor signs in the first time it uses Flekh.
- **Codex** (if `codex` is installed): `codex mcp add flekh --url …`, then `codex mcp login flekh`.

Safe to run again: anything already connected stays as it is. In a terminal it opens each sign-in in your browser;
when an AI agent runs it (no terminal), it prints the sign-in commands and asks you to restart the session
(`claude --continue` keeps the conversation). Exit code 1 means a step failed for a tool you have installed.

Claude apps (claude.ai, Desktop, mobile): open claude.ai › Settings › Connectors and add a custom connector with
`https://api.flekh.com/mcp`. Help: https://help.flekh.com/en/articles/connect-claude-chatgpt-or-cursor-to-flekh-mcp

`--api <url>` (or `FLEKH_API`) connects a non-production Flekh, e.g. `--api https://dev-api.flekh.com`.

## Upload

You don't run this yourself. Connect Flekh to your AI (connector URL `https://api.flekh.com/mcp`) and ask:

> upload ~/Movies/cut_v3.mp4 to Acme Studio as version 2 of Summer teaser

The connector's `start_upload(path)` checks the project's Agents rules and gives your AI one command with a one-time
ticket; your AI runs it:

```bash
npx -y @flekh/review upload ~/Movies/cut_v3.mp4 --ticket rvw_…
```

It sends the file straight to Flekh's storage in 16 MB parts (4 at a time, retried), then finishes the upload and
prints the file's link. Big files are fine (up to your plan's file limit).

- **Ticket:** one file, upload only, as you and your AI connection. Start it within 30 minutes; once started it
  lasts as long as the upload (24 h). It can't read anything in Flekh.
- **Resume:** run the same command again; it sends only the parts Flekh doesn't have.
- **Ctrl-C** cancels the upload; Flekh removes what it made.
- **Options:** `--api <url>` (or `FLEKH_API`) for a non-production Flekh, `--json` for one line of JSON.
- **Exit codes:** 0 uploaded · 1 refused by Flekh (message says why) · 2 network or storage problem (run again to resume).

## Attach files to a version

Source files, a zip of the project, notes: up to 10 files on each version, shown with it in Flekh. Ask your AI:

> upload ~/renders/cut_v3.mp4 as the next version of Summer teaser, and attach ~/renders/comp.zip

`start_upload(path, attach=[…])` gives one command that uploads the version, then attaches the files with the same ticket:

```bash
npx -y @flekh/review upload ~/renders/cut_v3.mp4 --ticket rvw_… --attach ~/renders/comp.zip --attach ~/notes.pdf
```

For a version already in Flekh, the connector's `attach_files` gives an attach-only ticket:

```bash
npx -y @flekh/review attach ~/renders/comp.zip ~/notes.pdf --ticket rvw_…
```

Each file goes straight to Flekh's storage (retried), then they're added to the version together and it prints
`✓ 2 files → <link>`. Every file is checked before anything is sent (missing file or more than 10: nothing uploaded).
Per-file size follows your plan's file limit. If the version uploaded but attaching failed, the version stays and
the message says so; ask the AI to call `attach_files` for it. Same `--api`, `--json` and exit codes as upload.
Claude Code (and other agents with a shell) only: chat apps can't read files on your computer.

Needs Node 18 or newer. No dependencies.

## Develop

```bash
npm test          # vitest, fake Flekh + S3, stubbed claude/codex + temp home for setup
npm run build     # dist/
npm publish       # @flekh org, public (prepublishOnly builds)
```

API: `Flekh-Backend-Service/docs/api/agents/02-agent-actions-contract.md` §1 "Upload tickets".
