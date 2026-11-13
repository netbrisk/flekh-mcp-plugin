import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attach } from "./attach";
import { ReviewError, upload } from "./upload";

// A fake Flekh (/v1/upload-tickets/*: start/complete for upload, attach/init + attach/commit) + S3 behind one fetch.
function fake(opts: { initStatus?: number; initError?: string; failPutOnce?: string[]; wrap?: boolean } = {}) {
  const log: string[] = [];
  const got = new Map<string, number>(); // S3 key → bytes
  const types = new Map<string, string>();
  const failed = new Set<string>();
  let uploaded = false;
  let committed: unknown[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(opts.wrap ? { status, response: body } : body), { status, headers: { "Content-Type": "application/json" } });
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.startsWith("https://s3.test/")) {
      const key = u.slice("https://s3.test/".length).split("?")[0];
      log.push(`PUT ${key}`);
      if (opts.failPutOnce?.includes(key) && !failed.has(key)) { failed.add(key); throw new Error("socket hang up"); }
      const body = Buffer.from(await new Response(init!.body as BodyInit).arrayBuffer());
      expect(new Headers(init!.headers).get("Content-Length")).toBe(String(body.length));
      types.set(key, new Headers(init!.headers).get("Content-Type") ?? "");
      got.set(key, body.length);
      return new Response("", { status: 200 });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Ticket rvw_t");
    const path = u.replace("https://api.test/v1/upload-tickets", "");
    log.push(`${init?.method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/start") return json(200, { upload_id: "up_1", part_size: 16 << 20, parts_total: 1, parts: [{ n: 1, url: "https://s3.test/part1" }] });
    if (path === "/complete") { uploaded = true; return json(200, { status: "processing", asset: { name: "cut.mp4", version: 3, link: "https://app.test/a/1/v/3" } }); }
    if (path === "/attach/init") {
      if (opts.initStatus) return json(opts.initStatus, { error: opts.initError, message: "nope" });
      if (opts.initError === "NOT_STARTED_UNLESS_UPLOADED" && !uploaded) return json(409, { error: "NOT_STARTED", message: "The upload hasn't finished yet." });
      const files = body.files as { name: string; size: number; mime: string }[];
      return json(200, { uploads: files.map((x, i) => ({ attachment_id: 100 + i, name: x.name, put_url: `https://s3.test/att/${x.name}?sig=1` })) });
    }
    if (path === "/attach/commit") {
      committed = body.attachment_ids;
      return json(200, { attachments: committed.map((id, i) => ({ id, name: `f${i}`, type: "application/zip", size: 1 })), link: "https://app.test/a/1/v/3" });
    }
    return json(404, {});
  };
  return { f: f as typeof fetch, log, got, types, committed: () => committed };
}

function files(...spec: [string, number][]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "attach-"));
  return spec.map(([name, size]) => { const p = join(dir, name); writeFileSync(p, Buffer.alloc(size, 3)); return p; });
}

const base = { ticket: "rvw_t", api: "https://api.test", sleep: async () => {} };

describe("attach", () => {
  it("sends two files and commits them", async () => {
    const fk = fake();
    const seen: string[] = [];
    const r = await attach(files(["comp.zip", 5000], ["notes.pdf", 300]), { ...base, fetch: fk.f, onProgress: (p) => seen.push(`${p.name}:${p.filesDone}/${p.filesTotal}`) });
    expect(fk.log).toEqual(["POST /attach/init", "PUT att/comp.zip", "PUT att/notes.pdf", "POST /attach/commit"]);
    expect(fk.got.get("att/comp.zip")).toBe(5000);
    expect(fk.got.get("att/notes.pdf")).toBe(300);
    expect(fk.types.get("att/notes.pdf")).toBe("application/pdf");
    expect(fk.committed()).toEqual([100, 101]);
    expect(r.attachments).toHaveLength(2);
    expect(r.link).toBe("https://app.test/a/1/v/3");
    expect(seen.at(-1)).toBe("notes.pdf:2/2");
  });

  it("reads wrapped replies", async () => {
    const fk = fake({ wrap: true });
    const r = await attach(files(["a.txt", 10]), { ...base, fetch: fk.f });
    expect(r.attachments).toHaveLength(1);
  });

  it("refuses a missing file before calling Flekh", async () => {
    const fk = fake();
    const err = await attach([...files(["a.txt", 10]), "/nope/b.zip"], { ...base, fetch: fk.f }).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewError);
    expect(err).toMatchObject({ code: "NO_FILE", refused: true, message: "No file at /nope/b.zip" });
    expect(fk.log).toEqual([]);
  });

  it("refuses more than 10 files", async () => {
    const fk = fake();
    const many = files(...Array.from({ length: 11 }, (_, i) => [`f${i}.txt`, 1] as [string, number]));
    const err = await attach(many, { ...base, fetch: fk.f }).catch((e) => e);
    expect(err).toMatchObject({ code: "TOO_MANY", refused: true });
    expect(fk.log).toEqual([]);
  });

  it("shows Flekh's 409 NOT_STARTED as a refusal", async () => {
    const fk = fake({ initStatus: 409, initError: "NOT_STARTED" });
    const err = await attach(files(["a.zip", 10]), { ...base, fetch: fk.f }).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_STARTED", refused: true, message: "nope" });
    expect(fk.log).toEqual(["POST /attach/init"]);
  });

  it("is a network problem (not refused) when Flekh can't be reached", async () => {
    const f = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const err = await attach(files(["a.zip", 10]), { ...base, fetch: f }).catch((e) => e);
    expect(err).toMatchObject({ code: "NETWORK", refused: false });
  });

  it("retries a failed PUT", async () => {
    const fk = fake({ failPutOnce: ["att/b.zip"] });
    await attach(files(["a.zip", 10], ["b.zip", 20]), { ...base, fetch: fk.f });
    expect(fk.log).toEqual(["POST /attach/init", "PUT att/a.zip", "PUT att/b.zip", "PUT att/b.zip", "POST /attach/commit"]);
    expect(fk.got.get("att/b.zip")).toBe(20);
  });

  it("gives up after 4 tries", async () => {
    const f0 = fake();
    const f = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).startsWith("https://s3.test/") ? new Response("", { status: 500 }) : f0.f(url, init)) as typeof fetch;
    const err = await attach(files(["a.zip", 10]), { ...base, fetch: f }).catch((e) => e);
    expect(err).toMatchObject({ code: "PUT_FAILED", refused: false });
    expect(f0.log).toEqual(["POST /attach/init"]);
  });

  it("upload then --attach with the same ticket attaches to the new version", async () => {
    const fk = fake({ initError: "NOT_STARTED_UNLESS_UPLOADED" });
    const [video, zip] = files(["cut.mp4", 1000], ["comp.zip", 50]);
    // before the upload completes Flekh says NOT_STARTED
    const early = await attach([zip], { ...base, fetch: fk.f }).catch((e) => e);
    expect(early).toMatchObject({ code: "NOT_STARTED", refused: true });
    fk.log.length = 0;
    const r = await upload({ ...base, path: video, fetch: fk.f });
    const at = await attach([zip], { ...base, fetch: fk.f });
    expect(r.version).toBe(3);
    expect(fk.log).toEqual(["POST /start", "PUT part1", "POST /complete", "POST /attach/init", "PUT att/comp.zip", "POST /attach/commit"]);
    expect(at.link).toBe("https://app.test/a/1/v/3");
  });
});
