import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serverUrl, setup, type RunResult } from "./setup";

const URL = "https://api.flekh.com/mcp";

function home(cursor?: string | null) {
  const h = mkdtempSync(join(tmpdir(), "flekh-setup-"));
  if (cursor !== undefined) {
    mkdirSync(join(h, ".cursor"));
    if (cursor !== null) writeFileSync(join(h, ".cursor", "mcp.json"), cursor);
  }
  return h;
}

// Stubbed world: which commands exist, what each `run` returns, what was called.
function world(o: { tools?: string[]; responses?: Record<string, RunResult>; interactive?: boolean; signInCode?: number; cursor?: string | null; api?: string } = {}) {
  const calls: string[] = [];
  const signIns: string[] = [];
  const lines: string[] = [];
  const h = home(o.cursor);
  const code = setup({
    api: o.api,
    home: h,
    hasCommand: (c) => (o.tools ?? []).includes(c),
    run: (cmd, args) => {
      const line = `${cmd} ${args.join(" ")}`;
      calls.push(line);
      return o.responses?.[line] ?? { ok: true, out: "" };
    },
    interactive: o.interactive ?? false,
    signIn: (cmd, args) => { signIns.push(`${cmd} ${args.join(" ")}`); return o.signInCode ?? 0; },
    log: (s) => lines.push(s),
  });
  return { code, calls, signIns, out: lines.join("\n"), home: h };
}

const CLAUDE_ADD = `claude mcp add --scope user --transport http flekh ${URL}`;
const CODEX_ADD = `codex mcp add flekh --url ${URL}`;
const HELP_WITH_LOGIN: RunResult = { ok: true, out: "Commands:\n  add\n  login [options] <name>\n  list\n" };

describe("serverUrl", () => {
  it("defaults to production and honours --api", () => {
    expect(serverUrl()).toBe(URL);
    expect(serverUrl("https://dev-api.flekh.com/")).toBe("https://dev-api.flekh.com/mcp");
  });
});

describe("Cursor", () => {
  const cfg = (h: string) => JSON.parse(readFileSync(join(h, ".cursor", "mcp.json"), "utf8"));

  it("skips when ~/.cursor is missing and writes nothing", () => {
    const w = world();
    expect(w.out).toContain("– Cursor not found");
    expect(existsSync(join(w.home, ".cursor"))).toBe(false);
    expect(w.code).toBe(0);
  });

  it("creates mcp.json when there is none", () => {
    const w = world({ cursor: null });
    expect(cfg(w.home)).toEqual({ mcpServers: { flekh: { url: URL } } });
    expect(w.out).toContain("✓ Cursor: Flekh added");
  });

  it("keeps other servers and settings", () => {
    const w = world({ cursor: JSON.stringify({ theme: "x", mcpServers: { other: { command: "o" } } }) });
    expect(cfg(w.home)).toEqual({ theme: "x", mcpServers: { other: { command: "o" }, flekh: { url: URL } } });
  });

  it("leaves it alone when Flekh is already there", () => {
    const before = JSON.stringify({ mcpServers: { flekh: { url: URL } } });
    const w = world({ cursor: before });
    expect(readFileSync(join(w.home, ".cursor", "mcp.json"), "utf8")).toBe(before);
    expect(w.out).toContain("✓ Cursor: Flekh already connected");
  });

  it("updates an old Flekh URL", () => {
    const w = world({ cursor: JSON.stringify({ mcpServers: { flekh: { url: "https://old/mcp" } } }), api: "https://dev-api.flekh.com" });
    expect(cfg(w.home).mcpServers.flekh.url).toBe("https://dev-api.flekh.com/mcp");
  });

  it("never overwrites invalid JSON and exits 1", () => {
    const bad = "{ mcpServers: // comment\n";
    const w = world({ cursor: bad });
    expect(readFileSync(join(w.home, ".cursor", "mcp.json"), "utf8")).toBe(bad);
    expect(w.out).toContain("✗ Cursor");
    expect(w.out).toContain(`"flekh": { "url": "${URL}" }`);
    expect(w.code).toBe(1);
  });
});

describe("Claude Code", () => {
  it("is skipped when not installed", () => {
    const w = world();
    expect(w.calls).toEqual([]);
    expect(w.out).toContain("– Claude Code not found");
  });

  it("adds at user scope and queues `claude mcp login` when the CLI has it", () => {
    const w = world({ tools: ["claude"], responses: { "claude mcp --help": HELP_WITH_LOGIN } });
    expect(w.calls).toEqual([CLAUDE_ADD, "claude mcp --help"]);
    expect(w.out).toContain("✓ Claude Code: Flekh connected");
    expect(w.out).toContain("Claude Code: claude mcp login flekh");
  });

  it("falls back to /mcp when the CLI has no login command", () => {
    const w = world({ tools: ["claude"], responses: { "claude mcp --help": { ok: true, out: "Commands:\n  add\n  list\n" } } });
    expect(w.out).toContain("Sign in: run /mcp in Claude Code, choose flekh");
    expect(w.out).not.toContain("claude mcp login");
  });

  it("treats 'already exists' as connected", () => {
    const w = world({ tools: ["claude"], responses: { [CLAUDE_ADD]: { ok: false, out: "MCP server flekh already exists in user config" }, "claude mcp --help": HELP_WITH_LOGIN } });
    expect(w.out).toContain("✓ Claude Code: Flekh already connected");
    expect(w.code).toBe(0);
  });

  it("prints the manual command, queues no sign-in and exits 1 on other errors", () => {
    const w = world({ tools: ["claude"], responses: { [CLAUDE_ADD]: { ok: false, out: "boom" } } });
    expect(w.out).toContain("✗ Claude Code");
    expect(w.out).toContain(CLAUDE_ADD);
    expect(w.calls).toEqual([CLAUDE_ADD]);
    expect(w.code).toBe(1);
  });
});

describe("Codex", () => {
  it("is skipped when not installed", () => {
    expect(world().out).toContain("– Codex not found");
  });

  it("adds with --url and queues codex mcp login", () => {
    const w = world({ tools: ["codex"] });
    expect(w.calls).toEqual([CODEX_ADD]);
    expect(w.out).toContain("✓ Codex: Flekh connected");
    expect(w.out).toContain("Codex: codex mcp login flekh");
  });

  it("treats 'already exists' as connected", () => {
    const w = world({ tools: ["codex"], responses: { [CODEX_ADD]: { ok: false, out: "Error: server 'flekh' already exists" } } });
    expect(w.out).toContain("✓ Codex: Flekh already connected");
    expect(w.code).toBe(0);
  });

  it("exits 1 when the add fails", () => {
    const w = world({ tools: ["codex"], responses: { [CODEX_ADD]: { ok: false, out: "nope" } } });
    expect(w.out).toContain(`✗ Codex: could not add Flekh. Run:\n      ${CODEX_ADD}`);
    expect(w.code).toBe(1);
  });
});

describe("sign-in", () => {
  const both = { tools: ["claude", "codex"], responses: { "claude mcp --help": HELP_WITH_LOGIN } };

  it("without a TTY (an agent ran it) prints the steps and runs nothing", () => {
    const w = world({ ...both, interactive: false });
    expect(w.signIns).toEqual([]);
    expect(w.out).toContain("Claude Code: claude mcp login flekh");
    expect(w.out).toContain("Codex: codex mcp login flekh");
    expect(w.out).toContain("claude --continue");
  });

  it("with a TTY runs each sign-in", () => {
    const w = world({ ...both, interactive: true });
    expect(w.signIns).toEqual(["claude mcp login flekh", "codex mcp login flekh"]);
    expect(w.out).toContain("✓ Claude Code: signed in");
    expect(w.out).not.toContain("claude --continue");
  });

  it("says how to retry a sign-in that did not finish", () => {
    const w = world({ ...both, interactive: true, signInCode: 1 });
    expect(w.out).toContain("sign-in did not finish. Run it again later: codex mcp login flekh");
  });

  it("always ends with the Claude apps note and the help link", () => {
    const w = world();
    expect(w.out).toContain("claude.ai › Settings › Connectors");
    expect(w.out).toContain("https://help.flekh.com/en/articles/connect-claude-chatgpt-or-cursor-to-flekh-mcp");
  });
});
