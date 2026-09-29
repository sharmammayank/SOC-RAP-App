import type { ParsedUpload } from "@/engine/ingest";
import { checkFileMeta } from "@/engine/ingest";

/** Parses in a Web Worker with a watchdog: a pathological file is abandoned instead of hanging the tab. */
export async function parseFileInWorker(file: File, timeoutMs = 120_000): Promise<ParsedUpload> {
  checkFileMeta(file.name, file.size);
  const buf = await file.arrayBuffer();
  const w = new Worker(new URL("../workers/parse.worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<ParsedUpload>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Reading the file took too long and was stopped. Check the file or split it.")), timeoutMs);
      w.onmessage = (e: MessageEvent<{ ok: boolean; res?: ParsedUpload; error?: string }>) => {
        clearTimeout(t);
        if (e.data.ok) resolve(e.data.res!);
        else reject(new Error(e.data.error));
      };
      w.onerror = (e) => {
        clearTimeout(t);
        reject(new Error(e.message || "The file couldn't be read."));
      };
      w.postMessage({ name: file.name, buf }, [buf]);
    });
  } finally {
    w.terminate();
  }
}
