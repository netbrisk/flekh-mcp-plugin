// Files from this computer attached to one file version in Flekh (source files, project zips…), with a ticket from the
// connector's attach_files (kind "attach") or start_upload(attach=[…]) (the same upload ticket, after its upload completes).
// init (names, sizes, types) → one presigned PUT per file, streamed, with retries → commit. Signed URLs never leave this process.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { PROD_API, ReviewError, mimeOf, unwrap } from "./upload.js";

export const MAX_FILES = 10;
const TRIES = 4; // 1 try + 3 retries

export interface AttachProgress { name: string; sent: number; size: number; filesDone: number; filesTotal: number }

export interface AttachOptions {
  ticket: string;
  api?: string;
  onProgress?: (p: AttachProgress) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface AttachResult {
  attachments: { id: number | string; name: string; type?: string; size?: number }[];
  link?: string;
}

/** Each path is a non-empty file, at most 10 of them; checked before anything is sent (upload --attach checks first too). */
export async function checkFiles(files: string[]): Promise<{ path: string; name: string; size: number; mime: string }[]> {
  if (files.length === 0) throw new ReviewError("No files to attach.", "NO_FILES", true);
  if (files.length > MAX_FILES) throw new ReviewError(`A version can have up to ${MAX_FILES} files (you gave ${files.length}).`, "TOO_MANY", true);

  const list: { path: string; name: string; size: number; mime: string }[] = [];
  for (const path of files) {
    const st = await stat(path).catch(() => null);
    if (!st || !st.isFile()) throw new ReviewError(`No file at ${path}`, "NO_FILE", true);
    if (st.size === 0) throw new ReviewError(`${path} is empty`, "EMPTY_FILE", true);
    list.push({ path, name: basename(path), size: st.size, mime: mimeOf(path) });
  }
  return list;
}

export async function attach(files: string[], o: AttachOptions): Promise<AttachResult> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const api = (o.api || PROD_API).replace(/\/+$/, "");
  const list = await checkFiles(files);

  // retry: only for calls that are safe to repeat (commit); init would make the attachments twice
  const flekh = async <T>(path: string, body: unknown, retry: boolean): Promise<T> => {
    for (let i = 1; ; i++) {
      let res: Response;
      try {
        res = await f(`${api}/v1/upload-tickets${path}`, {
          method: "POST",
          headers: { Authorization: `Ticket ${o.ticket}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (retry && i < TRIES) { await sleep(500 * 2 ** i); continue; }
        throw new ReviewError(`Can't reach Flekh (${api}): ${(e as Error).message}`, "NETWORK");
      }
      const json = unwrap(await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
      if (res.ok) return json;
      if (retry && res.status >= 500 && i < TRIES) { await sleep(500 * 2 ** i); continue; }
      throw new ReviewError(json.message || `Flekh answered ${res.status}`, json.error || `HTTP_${res.status}`, res.status < 500);
    }
  };

  const init = await flekh<{ uploads?: { attachment_id: number | string; name: string; put_url: string }[] }>(
    "/attach/init", { files: list.map(({ name, size, mime }) => ({ name, size, mime })) }, false);
  const ups = init.uploads;
  if (!Array.isArray(ups) || ups.length !== list.length || ups.some((u) => !u.put_url)) {
    throw new ReviewError("Flekh's reply didn't say where to send the files. Update @flekh/review and run the command again.", "BAD_REPLY");
  }

  let filesDone = 0;
  for (let k = 0; k < list.length; k++) {
    const file = list[k];
    const url = ups[k].put_url;
    const report = (sent: number) => o.onProgress?.({ name: file.name, sent, size: file.size, filesDone, filesTotal: list.length });
    report(0);
    for (let i = 1; ; i++) {
      let status = 0;
      let sent = 0;
      try {
        const counted = (Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, c) { sent += chunk.byteLength; report(sent); c.enqueue(chunk); } }));
        const res = await f(url, {
          method: "PUT",
          body: counted,
          headers: { "Content-Length": String(file.size), "Content-Type": file.mime },
          duplex: "half",
        } as RequestInit);
        status = res.status;
        if (res.ok) break;
      } catch { /* network: retry */ }
      if (i >= TRIES) throw new ReviewError(`${file.name} didn't upload${status ? ` (S3 ${status})` : ""}. Ask the AI for a new ticket and try again.`, "PUT_FAILED");
      await sleep(500 * 2 ** i);
    }
    filesDone++;
    report(file.size);
  }

  const done = await flekh<AttachResult>("/attach/commit", { attachment_ids: ups.map((u) => u.attachment_id) }, true);
  return { attachments: done.attachments ?? [], link: done.link };
}
