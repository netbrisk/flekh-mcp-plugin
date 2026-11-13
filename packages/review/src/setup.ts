// flekh-review setup [--api URL]
// Connects the Flekh MCP server to the AI tools on this computer: Claude Code (user scope), Cursor, Codex.
// Safe to run again: every step checks what is already there.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API = "https://api.flekh.com";
export const SERVER_NAME = "flekh";
export const DOCS_URL = "https://help.flekh.com/en/articles/connect-claude-chatgpt-or-cursor-to-flekh-mcp";

export type RunResult = { ok: boolean; out: string };
export type Run = (cmd: string, args: string[]) => RunResult;

export type SetupOptions = {
  api?: string;
  home?: string;
  run?: Run;
  hasCommand?: (cmd: string) => boolean;
  /** true when a person is at the terminal (stdin + stdout are TTYs). */
  interactive?: boolean;
  /** Runs a sign-in command with the terminal attached; returns its exit code. */
  signIn?: (cmd: string, args: string[]) => number;
  log?: (line: string) => void;
};

type SignIn = { label: string; cmd: string; args: string[] };

const win = process.platform === "win32";

const defaultHasCommand = (cmd: string) => spawnSync(win ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;

const defaultRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: win });
  return { ok: r.status === 0, out: `${r.stderr ?? ""}${r.stdout ?? ""}` };
};

const defaultSignIn = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "inherit", shell: win }).status ?? 1;

export function serverUrl(api: string = DEFAULT_API): string {
  return `${api.replace(/\/+$/, "")}/mcp`;
}

const already = (out: string) => /already exists/i.test(out);

/** Result of one step: "ok", "skip" (tool not installed) or "fail" (installed, but the step did not work). */
export type Step = "ok" | "skip" | "fail";

export function connectCursor(home: string, url: string, log: (s: string) => void): Step {
  const dir = join(home, ".cursor");
  if (!existsSync(dir)) { log("  – Cursor not found"); return "skip"; }
  const file = join(dir, "mcp.json");
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8") || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed;
    } catch {
      log(`  ✗ Cursor: ${file} is not valid JSON, so it was left alone. Add this under "mcpServers" yourself:\n      "${SERVER_NAME}": { "url": "${url}" }`);
      return "fail";
    }
  }
  const servers = (config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? config.mcpServers : {}) as Record<string, { url?: string }>;
  if (servers[SERVER_NAME]?.url === url) { log("  ✓ Cursor: Flekh already connected"); return "ok"; }
  servers[SERVER_NAME] = { url };
  config.mcpServers = servers;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  log("  ✓ Cursor: Flekh added to ~/.cursor/mcp.json (it signs in the first time it uses Flekh)");
  return "ok";
}

function connectClaude(url: string, run: Run, has: (c: string) => boolean, log: (s: string) => void, queue: SignIn[]): Step {
  if (!has("claude")) { log("  – Claude Code not found"); return "skip"; }
  const r = run("claude", ["mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, url]);
  if (r.ok) log("  ✓ Claude Code: Flekh connected (every project)");
  else if (already(r.out)) log("  ✓ Claude Code: Flekh already connected");
  else {
    log(`  ✗ Claude Code: could not add Flekh. Run:\n      claude mcp add --scope user --transport http ${SERVER_NAME} ${url}`);
    return "fail";
  }
  // `claude mcp login` only exists in newer Claude Code; older ones sign in from /mcp.
  if (/^\s+login\b/m.test(run("claude", ["mcp", "--help"]).out)) queue.push({ label: "Claude Code", cmd: "claude", args: ["mcp", "login", SERVER_NAME] });
  else log(`    Sign in: run /mcp in Claude Code, choose ${SERVER_NAME}`);
  return "ok";
}

function connectCodex(url: string, run: Run, has: (c: string) => boolean, log: (s: string) => void, queue: SignIn[]): Step {
  if (!has("codex")) { log("  – Codex not found"); return "skip"; }
  const r = run("codex", ["mcp", "add", SERVER_NAME, "--url", url]);
  if (r.ok) log("  ✓ Codex: Flekh connected");
  else if (already(r.out)) log("  ✓ Codex: Flekh already connected");
  else {
    log(`  ✗ Codex: could not add Flekh. Run:\n      codex mcp add ${SERVER_NAME} --url ${url}`);
    return "fail";
  }
  queue.push({ label: "Codex", cmd: "codex", args: ["mcp", "login", SERVER_NAME] });
  return "ok";
}

/** Returns the exit code: 1 when a step failed for a tool that is installed, else 0. */
export function setup(opts: SetupOptions = {}): number {
  const url = serverUrl(opts.api || DEFAULT_API);
  const home = opts.home ?? homedir();
  const run = opts.run ?? defaultRun;
  const has = opts.hasCommand ?? defaultHasCommand;
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const signIn = opts.signIn ?? defaultSignIn;
  const log = opts.log ?? ((s: string) => console.log(s));
  const queue: SignIn[] = [];

  log("\nFlekh: review, approve and publish video with your team and your AI\n");
  log(`Connecting Flekh (${url}):\n`);
  const steps: Step[] = [
    connectClaude(url, run, has, log, queue),
    connectCursor(home, url, log),
    connectCodex(url, run, has, log, queue),
  ];

  if (queue.length > 0) {
    if (interactive) {
      for (const s of queue) {
        log(`\n${s.label}: signing in to Flekh (your browser opens)…\n`);
        const line = `${s.cmd} ${s.args.join(" ")}`;
        if (signIn(s.cmd, s.args) === 0) log(`  ✓ ${s.label}: signed in`);
        else log(`  ✗ ${s.label}: sign-in did not finish. Run it again later: ${line}`);
      }
    } else {
      log("\nSign in to Flekh once (each opens your browser):");
      for (const s of queue) log(`  ${s.label}: ${s.cmd} ${s.args.join(" ")}`);
      log("Then restart the session so it loads Flekh (Claude Code: claude --continue keeps the conversation).");
    }
  }

  log(`
Claude apps (claude.ai, Desktop, mobile): open claude.ai › Settings › Connectors,
add a custom connector with ${url} and sign in. It then works in every Claude app.

Help: ${DOCS_URL}
`);
  return steps.includes("fail") ? 1 : 0;
}
