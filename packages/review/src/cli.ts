#!/usr/bin/env node
// flekh-review setup [--api URL]
// flekh-review upload <path> --ticket rvw_… [--attach <file>]… [--api URL] [--json]
// flekh-review attach <files…> --ticket rvw_… [--api URL] [--json]
// upload is run by an AI agent (Claude Code, Codex, Cursor…) as the Flekh connector's start_upload(path) tells it to.
import { readFileSync } from "node:fs";
import { attach, checkFiles, type AttachProgress, type AttachResult } from "./attach.js";
import { setup } from "./setup.js";
import { ReviewError, cancel, upload, type Progress } from "./upload.js";

const HELP = `Connect Flekh to your AI tools, and upload files from this computer to Flekh.

  npx -y @flekh/review setup [--api <url>]
      Adds the Flekh MCP server to Claude Code, Cursor and Codex on this computer, then signs you in.

  npx -y @flekh/review upload <path> --ticket <rvw_…> [--attach <file>]… [--api <url>] [--json]
      Uploads a file (or a new version). Each --attach file (up to 10) is then attached to that version.

  npx -y @flekh/review attach <file>… --ticket <rvw_…> [--api <url>] [--json]
      Attaches files (source files, a project zip…; up to 10) to an existing version.

Ask your AI (with the Flekh connector) to upload or attach files by their paths; it gets a one-time ticket and runs this for you.
Exit codes: 0 done · 1 refused by Flekh (see the message) · 2 network or S3 problem (run it again; an upload resumes).`;

function args(argv: string[]) {
  const out: { cmd?: string; path?: string; paths: string[]; attach: string[]; ticket?: string; api?: string; json: boolean; help: boolean; version: boolean } =
    { paths: [], attach: [], json: false, help: false, version: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ticket") out.ticket = argv[++i];
    else if (a.startsWith("--ticket=")) out.ticket = a.slice(9);
    else if (a === "--api") out.api = argv[++i];
    else if (a.startsWith("--api=")) out.api = a.slice(6);
    else if (a === "--attach") { if (argv[i + 1] !== undefined) out.attach.push(argv[++i]); }
    else if (a.startsWith("--attach=")) out.attach.push(a.slice(9));
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else rest.push(a);
  }
  [out.cmd, ...out.paths] = rest;
  out.path = out.paths[0];
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
  if (a.help || !a.ticket || !a.path || !(a.cmd === "upload" || a.cmd === "attach")) {
    console.log(HELP);
    return a.help ? 0 : 1;
  }
  const api = a.api || process.env.FLEKH_API;
  const tty = process.stderr.isTTY && !a.json;
  const fail = (e: unknown) => (e instanceof ReviewError ? e : new ReviewError((e as Error).message, "ERROR"));

  // attach: progress like upload's (one TTY line, else a plain line per file), then "✓ n files → link"
  const runAttach = async (files: string[]): Promise<AttachResult> => {
    let lastFile = -1;
    const onProgress = (p: AttachProgress) => {
      const pct = p.size ? Math.floor((p.sent / p.size) * 100) : 100;
      if (tty) process.stderr.write(`\r${p.name} ${pct}% · ${bytes(p.sent)} of ${bytes(p.size)} · file ${Math.min(p.filesDone + 1, p.filesTotal)}/${p.filesTotal}   `);
      else if (!a.json && p.filesDone !== lastFile && p.sent === 0) { console.log(`Attaching ${p.name} (${p.filesDone + 1}/${p.filesTotal})`); lastFile = p.filesDone; }
    };
    try {
      return await attach(files, { ticket: a.ticket!, api, onProgress });
    } finally {
      if (tty) process.stderr.write("\n");
    }
  };
  const attached = (r: AttachResult) => `✓ ${r.attachments.length} file${r.attachments.length === 1 ? "" : "s"}${r.link ? ` → ${r.link}` : " attached"}`;

  if (a.cmd === "attach") {
    try {
      const r = await runAttach(a.paths);
      if (a.json) console.log(JSON.stringify({ ok: true, ...r }));
      else console.log(attached(r));
      return 0;
    } catch (e) {
      const err = fail(e);
      if (a.json) console.log(JSON.stringify({ ok: false, error: err.code, message: err.message }));
      else console.error(`✗ ${err.message}`);
      return err.refused ? 1 : 2;
    }
  }
  if (a.paths.length > 1) {
    console.error(`✗ upload takes one file; use --attach <file> to attach others to the new version.`);
    return 1;
  }
  if (a.attach.length) {
    try {
      await checkFiles(a.attach);
    } catch (e) {
      const err = fail(e);
      if (a.json) console.log(JSON.stringify({ ok: false, error: err.code, message: err.message }));
      else console.error(`✗ ${err.message} (nothing uploaded)`);
      return 1;
    }
  }
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
    if (!a.json) console.log(`✓ ${r.name} (${bytes(r.size)})${r.version ? ` → v${r.version}` : ""}${r.project ? ` in ${r.project}` : ""}${r.link ? ` · ${r.link}` : ""}\n  Flekh is processing it now (thumbnail and preview in a minute).`);
    if (!a.attach.length) {
      if (a.json) console.log(JSON.stringify({ ok: true, ...r }));
      return 0;
    }
    // same ticket: Flekh allows attaching once its upload has completed
    try {
      const at = await runAttach(a.attach);
      if (a.json) console.log(JSON.stringify({ ok: true, ...r, attached: at }));
      else console.log(attached(at));
      return 0;
    } catch (e) {
      const err = fail(e);
      if (a.json) console.log(JSON.stringify({ ok: false, uploaded: r, error: err.code, message: err.message }));
      else console.error(`✗ The version was uploaded, but its files weren't attached: ${err.message}`);
      return err.refused ? 1 : 2;
    }
  } catch (e) {
    finished = true;
    if (tty) process.stderr.write("\n");
    const err = fail(e);
    if (a.json) console.log(JSON.stringify({ ok: false, error: err.code, message: err.message }));
    else console.error(`✗ ${err.message}`);
    return err.refused ? 1 : 2;
  }
}

main().then((code) => process.exit(code));
