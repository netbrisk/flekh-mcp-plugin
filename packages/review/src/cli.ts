#!/usr/bin/env node
// flekh-review setup [--api URL]
// flekh-review upload <path> --ticket rvw_… [--api URL] [--json]
// upload is run by an AI agent (Claude Code, Codex, Cursor…) as the Flekh connector's start_upload(path) tells it to.
import { readFileSync } from "node:fs";
import { setup } from "./setup.js";
import { ReviewError, cancel, upload, type Progress } from "./upload.js";

const HELP = `Connect Flekh to your AI tools, and upload files from this computer to Flekh.

  npx -y @flekh/review setup [--api <url>]
      Adds the Flekh MCP server to Claude Code, Cursor and Codex on this computer, then signs you in.

  npx -y @flekh/review upload <path> --ticket <rvw_…> [--api <url>] [--json]

Ask your AI (with the Flekh connector) to upload a file by its path; it gets a one-time ticket and runs this for you.
Exit codes: 0 uploaded · 1 refused by Flekh (see the message) · 2 network or S3 problem (run it again to resume).`;

function args(argv: string[]) {
  const out: { cmd?: string; path?: string; ticket?: string; api?: string; json: boolean; help: boolean; version: boolean } = { json: false, help: false, version: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ticket") out.ticket = argv[++i];
    else if (a.startsWith("--ticket=")) out.ticket = a.slice(9);
    else if (a === "--api") out.api = argv[++i];
    else if (a.startsWith("--api=")) out.api = a.slice(6);
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else rest.push(a);
  }
  [out.cmd, out.path] = rest;
  return out;
}

export function bytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  if (a.version) { console.log(version()); return 0; }
  if (a.cmd === "setup" && !a.help) return setup({ api: a.api || process.env.FLEKH_API });
  if (a.help || a.cmd !== "upload" || !a.path || !a.ticket) {
    console.log(HELP);
    return a.help ? 0 : 1;
  }
  const api = a.api || process.env.FLEKH_API;
  const tty = process.stderr.isTTY && !a.json;
  let lastPct = -1;
  const onProgress = (p: Progress) => {
    const pct = Math.floor((p.sent / p.size) * 100);
    if (tty) process.stderr.write(`\r${pct}% · ${bytes(p.sent)} of ${bytes(p.size)} · part ${p.partsDone}/${p.partsTotal}   `);
    else if (!a.json && pct >= lastPct + 10) { console.log(`${pct}% (${p.partsDone}/${p.partsTotal} parts)`); lastPct = pct - (pct % 10); }
  };
  let finished = false;
  process.once("SIGINT", () => {
    if (finished) process.exit(130);
    console.error("\nCancelling…");
    void cancel({ ticket: a.ticket!, api }).finally(() => process.exit(130));
  });
  try {
    const r = await upload({ path: a.path, ticket: a.ticket, api, onProgress });
    finished = true;
    if (tty) process.stderr.write("\n");
    if (a.json) console.log(JSON.stringify({ ok: true, ...r }));
    else console.log(`✓ ${r.name} (${bytes(r.size)})${r.version ? ` → v${r.version}` : ""}${r.project ? ` in ${r.project}` : ""}${r.link ? ` · ${r.link}` : ""}\n  Flekh is processing it now (thumbnail and preview in a minute).`);
    return 0;
  } catch (e) {
    finished = true;
    if (tty) process.stderr.write("\n");
    const err = e instanceof ReviewError ? e : new ReviewError((e as Error).message, "ERROR");
    if (a.json) console.log(JSON.stringify({ ok: false, error: err.code, message: err.message }));
    else console.error(`✗ ${err.message}`);
    return err.refused ? 1 : 2;
  }
}

main().then((code) => process.exit(code));
