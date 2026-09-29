/// <reference lib="webworker" />
/* Parses uploads off the main thread so large files never freeze the page. */
import { parseUpload } from "@/engine/ingest";

self.onmessage = async (e: MessageEvent<{ name: string; buf: ArrayBuffer }>) => {
  try {
    const res = await parseUpload(e.data.name, e.data.buf);
    (self as unknown as Worker).postMessage({ ok: true, res });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
