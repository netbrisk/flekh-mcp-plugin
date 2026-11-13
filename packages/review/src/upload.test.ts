import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewError, unwrap, upload } from "./upload";

const MB = 1 << 20;
const PART = 16 * MB;

// A fake Flekh (/v1/upload-tickets/*) + S3 (PUT part URLs) behind one fetch.
function fake(opts: { size: number; doneAlready?: number[]; failPutOnce?: number[]; expireOnce?: number[]; startStatus?: number; startError?: string; wrap?: boolean; startBody?: unknown }) {
  const total = Math.ceil(opts.size / PART);
  const got = new Map<number, number>((opts.doneAlready ?? []).map((n) => [n, n === total ? opts.size - (n - 1) * PART : PART]));
  const failed = new Set<number>();
  const expired = new Set<number>();
  const log: string[] = [];
  let signed = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const sign = (n: number) => `https://s3.test/part/${n}?sig=${++signed}`;
  // wrap: like production, where Go's ResponseInterceptor sends {status, response: body}
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(opts.wrap ? { status, response: body } : body), { status, headers: { "Content-Type": "application/json" } });
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.startsWith("https://s3.test/part/")) {
      const n = Number(u.split("/part/")[1].split("?")[0]);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      if (opts.expireOnce?.includes(n) && !expired.has(n)) { expired.add(n); return new Response("expired", { status: 403 }); }
      if (opts.failPutOnce?.includes(n) && !failed.has(n)) { failed.add(n); throw new Error("socket hang up"); }
      got.set(n, (init!.body as Buffer).length);
      return new Response("", { status: 200 });
    }
    const h = new Headers(init?.headers);
    expect(h.get("Authorization")).toBe("Ticket rvw_t");
    const path = u.replace("https://api.test/v1/upload-tickets", "");
    log.push(`${init?.method} ${path}`);
    if (path === "/start") {
      if (opts.startStatus) return json(opts.startStatus, { error: opts.startError, message: "nope", upload_id: "up_1" });
      if (opts.startBody !== undefined) return json(200, opts.startBody);
      return json(200, { upload_id: "up_1", part_size: PART, parts_total: total, max_parallel: 4, asset_name: "cut.mp4", version: 1,
        parts: Array.from({ length: Math.min(8, total) }, (_, i) => ({ n: i + 1, url: sign(i + 1) })) });
    }
    if (path === "/status") return json(200, { upload_id: "up_1", part_size: PART, parts_total: total, size: opts.size, parts_done: [...got.keys()] });
    if (path === "/parts") {
      const want = JSON.parse(String(init!.body)).parts as number[];
      expect(want.length).toBeLessThanOrEqual(32);
      return json(200, { parts: want.map((n) => ({ n, url: sign(n) })) });
    }
    if (path === "/complete") {
      const bytes = [...got.values()].reduce((a, b) => a + b, 0);
      if (got.size !== total || bytes !== opts.size) return json(400, { error: "INCOMPLETE", message: "missing parts" });
      return json(200, { status: "processing", asset: { name: "cut.mp4", version: 2, link: "https://app.test/a/1", project: { name: "Acme" } } });
    }
    return json(404, {});
  };
  return { f: f as typeof fetch, got, log, stats: () => ({ signed, maxInFlight }) };
}

function file(size: number): string {
  const p = join(mkdtempSync(join(tmpdir(), "review-")), "cut.mp4");
  writeFileSync(p, Buffer.alloc(size, 7));
  return p;
}

const base = { ticket: "rvw_t", api: "https://api.test", sleep: async () => {} };

describe("upload", () => {
  it("sends a one-part file and completes", async () => {
    const fk = fake({ size: 1000 });
    const r = await upload({ ...base, path: file(1000), fetch: fk.f });
    expect(r).toMatchObject({ name: "cut.mp4", version: 2, size: 1000, link: "https://app.test/a/1", project: "Acme" });
    expect(fk.log).toEqual(["POST /start", "POST /complete"]);
  });

  it("sends 70 parts, at most 4 at a time, fetching URLs in batches of 32", async () => {
    const size = 69 * PART + 123;
    const fk = fake({ size });
    const seen: number[] = [];
    await upload({ ...base, path: file(size), fetch: fk.f, onProgress: (p) => seen.push(p.partsDone) });
    expect(fk.got.size).toBe(70);
    expect(fk.got.get(70)).toBe(123);
    expect(fk.stats().maxInFlight).toBeLessThanOrEqual(4);
    expect(fk.log.filter((l) => l === "POST /parts").length).toBeLessThanOrEqual(4);
    expect(seen.at(-1)).toBe(70);
  }, 20000);

  it("retries a failed part and refreshes an expired URL", async () => {
    const size = 3 * PART;
    const fk = fake({ size, failPutOnce: [2], expireOnce: [3] });
    await upload({ ...base, path: file(size), fetch: fk.f });
    expect(fk.got.size).toBe(3);
  });

  it("resumes a started upload, sending only the missing parts", async () => {
    const size = 3 * PART;
    const fk = fake({ size, doneAlready: [1, 2], startStatus: 409, startError: "ALREADY_STARTED" });
    await upload({ ...base, path: file(size), fetch: fk.f });
    expect(fk.log).toEqual(["POST /start", "GET /status", "POST /parts", "POST /complete"]);
  });

  it("shows Flekh's refusal", async () => {
    const fk = fake({ size: 10, startStatus: 410, startError: "TICKET_EXPIRED" });
    const err = await upload({ ...base, path: file(10), fetch: fk.f }).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewError);
    expect(err).toMatchObject({ code: "TICKET_EXPIRED", refused: true, message: "nope" });
  });

  it("reads production's wrapped replies ({status, response})", async () => {
    const fk = fake({ size: 1000, wrap: true });
    const r = await upload({ ...base, path: file(1000), fetch: fk.f });
    expect(r).toMatchObject({ name: "cut.mp4", version: 2, size: 1000, link: "https://app.test/a/1", project: "Acme" });
    expect(fk.got.size).toBe(1);
    const size = 3 * PART;
    const many = fake({ size, wrap: true, doneAlready: [1], startStatus: 409, startError: "ALREADY_STARTED" });
    await upload({ ...base, path: file(size), fetch: many.f });
    expect(many.got.size).toBe(3);
  });

  it("shows a wrapped refusal's own message", async () => {
    const fk = fake({ size: 10, wrap: true, startStatus: 410, startError: "TICKET_EXPIRED" });
    const err = await upload({ ...base, path: file(10), fetch: fk.f }).catch((e) => e);
    expect(err).toMatchObject({ code: "TICKET_EXPIRED", message: "nope" });
  });

  it("stops, without completing, when the start reply has no upload plan", async () => {
    const fk = fake({ size: 10, startBody: { d: "encrypted…" } });
    const err = await upload({ ...base, path: file(10), fetch: fk.f }).catch((e) => e);
    expect(err).toMatchObject({ code: "BAD_REPLY" });
    expect(fk.log).toEqual(["POST /start"]);
  });

  it("unwraps only the {status, response} envelope", () => {
    expect(unwrap({ status: 200, response: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrap({ status: 200, response: null })).toEqual({});
    expect(unwrap({ status: "processing", asset: {} })).toEqual({ status: "processing", asset: {} });
    expect(unwrap({ status: 200, response: 1, extra: true })).toEqual({ status: 200, response: 1, extra: true });
  });

  it("refuses a missing file before calling Flekh", async () => {
    const fk = fake({ size: 10 });
    const err = await upload({ ...base, path: "/nope/x.mp4", fetch: fk.f }).catch((e) => e);
    expect(err.code).toBe("NO_FILE");
    expect(fk.log).toEqual([]);
  });
});
