// One file from this computer into Flekh with a one-time upload ticket (made by the Flekh connector's start_upload(path)).
// start (size, type) → part URLs in batches → PUT 16 MiB parts straight to S3, a few at a time, with retries → complete.
// A re-run with the same ticket resumes: Flekh says which parts it already has. Signed URLs never leave this process.
import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

export const PROD_API = "https://api.flekh.com";
const BATCH = 32; // part URLs per /parts call (Flekh's cap)
const TRIES = 4;

export class ReviewError extends Error {
  constructor(message: string, readonly code: string, readonly refused = false) {
    super(message);
  }
}

export interface Progress { sent: number; size: number; partsDone: number; partsTotal: number }

export interface UploadOptions {
  path: string;
  ticket: string;
  api?: string;
  parallel?: number;
  onProgress?: (p: Progress) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface UploadResult {
  name: string;
  version?: number;
  size: number;
  link?: string;
  project?: string;
  status?: string;
}

interface Session {
  upload_id: string;
  part_size: number;
  parts_total: number;
  max_parallel?: number;
  parts?: { n: number; url: string }[];
  parts_done?: number[];
  size?: number;
  asset_name?: string;
  version?: number;
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo", ".mxf": "application/mxf", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac",
  ".m4a": "audio/mp4", ".flac": "audio/flac", ".ogg": "audio/ogg", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".tif": "image/tiff", ".tiff": "image/tiff", ".pdf": "application/pdf",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
};

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Flekh's API wraps every JSON reply as `{status: <http code>, response: <body>}`; the body is what we want. */
export function unwrap(data: unknown): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    const keys = Object.keys(d);
    if (keys.length === 2 && typeof d.status === "number" && "response" in d) return d.response ?? {};
  }
  return data;
}

export async function upload(o: UploadOptions): Promise<UploadResult> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const api = (o.api || PROD_API).replace(/\/+$/, "");
  const st = await stat(o.path).catch(() => null);
  if (!st || !st.isFile()) throw new ReviewError(`No file at ${o.path}`, "NO_FILE", true);
  if (st.size === 0) throw new ReviewError(`${o.path} is empty`, "EMPTY_FILE", true);
  const size = st.size;

  const flekh = async <T>(method: string, path: string, body?: unknown, okCodes: number[] = []): Promise<{ status: number; json: T }> => {
    for (let i = 1; ; i++) {
      let res: Response;
      try {
        res = await f(`${api}/v1/upload-tickets${path}`, {
          method,
          headers: { Authorization: `Ticket ${o.ticket}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        if (i < TRIES) { await sleep(500 * 2 ** i); continue; }
        throw new ReviewError(`Can't reach Flekh (${api}): ${(e as Error).message}`, "NETWORK");
      }
      const json = unwrap(await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
      if (res.ok || okCodes.includes(res.status)) return { status: res.status, json };
      if (res.status >= 500 && i < TRIES) { await sleep(500 * 2 ** i); continue; }
      throw new ReviewError(json.message || `Flekh answered ${res.status}`, json.error || `HTTP_${res.status}`, res.status < 500);
    }
  };

  // start, or resume a run of the same ticket
  let s: Session;
  const started = await flekh<Session & { error?: string }>("POST", "/start", { name: basename(o.path), size, mime: mimeOf(o.path) }, [409]);
  if (started.status === 409 && started.json.error === "ALREADY_STARTED") {
    s = (await flekh<Session>("GET", "/status")).json;
    if (s.size !== undefined && s.size !== size) {
      throw new ReviewError("This ticket's upload is for a different file (size changed). Ask the AI to start the upload again.", "SIZE_CHANGED", true);
    }
  } else if (started.status === 409) {
    throw new ReviewError((started.json as { message?: string }).message || "This upload ticket was already used.", started.json.error || "CONFLICT", true);
  } else {
    s = started.json;
  }
  const partSize = s.part_size;
  const total = s.parts_total;
  // never "complete" an upload we couldn't read the plan for (it would send no parts and Flekh would refuse it)
  if (!Number.isInteger(total) || total < 1 || !(partSize > 0)) {
    throw new ReviewError("Flekh's reply didn't say how to send the file. Update @flekh/review and run the command again.", "BAD_REPLY");
  }
  const done = new Set<number>(Array.isArray(s.parts_done) ? s.parts_done : []);
  const urls = new Map<number, string>((s.parts ?? []).map((p) => [p.n, p.url]));
  const lenOf = (n: number) => (n === total ? size - (n - 1) * partSize : partSize);
  let sent = 0;
  for (const n of done) sent += lenOf(n);
  const report = () => o.onProgress?.({ sent, size, partsDone: done.size, partsTotal: total });
  report();

  const todo = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !done.has(n));
  let refill: Promise<void> | null = null;
  const urlFor = async (n: number, fresh = false): Promise<string> => {
    if (fresh) urls.delete(n);
    while (!urls.has(n)) {
      if (!refill) {
        const want = [n, ...todo.filter((m) => m !== n && !urls.has(m) && !done.has(m))].slice(0, BATCH);
        refill = flekh<{ parts: { n: number; url: string }[] }>("POST", "/parts", { parts: want })
          .then((r) => { for (const p of r.json.parts) urls.set(p.n, p.url); })
          .finally(() => { refill = null; });
      }
      await refill;
    }
    return urls.get(n)!;
  };

  const fh = await open(o.path, "r");
  try {
    const sendPart = async (n: number) => {
      const len = lenOf(n);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, (n - 1) * partSize);
      if (bytesRead !== len) throw new ReviewError(`${o.path} changed while uploading`, "FILE_CHANGED", true);
      for (let i = 1; ; i++) {
        const url = await urlFor(n, i > 1);
        let status = 0;
        try {
          const res = await f(url, { method: "PUT", body: buf, headers: { "Content-Length": String(len) } });
          status = res.status;
          if (res.ok) break;
        } catch { /* network: retry */ }
        if (i >= TRIES) throw new ReviewError(`Part ${n} of ${total} didn't upload${status ? ` (S3 ${status})` : ""}. Run the same command again to resume.`, "PART_FAILED");
        await sleep(500 * 2 ** i);
      }
      urls.delete(n);
      done.add(n);
      sent += len;
      report();
    };
    const queue = [...todo];
    const workers = Math.max(1, Math.min(o.parallel ?? s.max_parallel ?? 4, 8, queue.length || 1));
    await Promise.all(Array.from({ length: workers }, async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) await sendPart(n);
    }));
  } finally {
    await fh.close();
  }

  const card = (await flekh<{ asset?: { name?: string; version?: number; link?: string; project?: { name?: string } }; status?: string }>("POST", "/complete")).json;
  const a = card.asset ?? {};
  return { name: a.name ?? s.asset_name ?? basename(o.path), version: a.version ?? s.version, size, link: a.link, project: a.project?.name, status: card.status };
}

/** Cancel the ticket's upload (Ctrl-C): Flekh removes what it made. */
export async function cancel(o: Pick<UploadOptions, "ticket" | "api" | "fetch">): Promise<void> {
  const f = o.fetch ?? fetch;
  const api = (o.api || PROD_API).replace(/\/+$/, "");
  await f(`${api}/v1/upload-tickets/cancel`, { method: "POST", headers: { Authorization: `Ticket ${o.ticket}` } }).catch(() => undefined);
}
