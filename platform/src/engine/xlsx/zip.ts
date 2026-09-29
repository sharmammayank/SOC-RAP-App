/* Minimal zip reading and writing on the platform's DecompressionStream / CompressionStream (browser, worker, Node 18+). */

export const LIMITS = {
  MAX_BYTES: 100 * 1024 * 1024,
  MAX_UNZIPPED: 800 * 1024 * 1024,
  MAX_RATIO: 100,
  MAX_ENTRIES: 1000,
  MAX_PART: 300 * 1024 * 1024,
};

export interface ZipEntry {
  method: number;
  csize: number;
  usize: number;
  off: number;
}
const dec = new TextDecoder();

function findEocd(dv: DataView, len: number): number {
  for (let i = len - 22; i >= Math.max(0, len - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) return i;
  return -1;
}

/**
 * Pre-parse safety checks (spec §8.4 / MVP security review): valid zip, entry count, declared expansion size and ratio,
 * no macros or ActiveX, no absolute or parent-relative paths.
 */
export function inspectZip(buf: ArrayBuffer): void {
  const dv = new DataView(buf);
  if (buf.byteLength < 22 || dv.getUint32(0, true) !== 0x04034b50) throw new Error("This isn't a valid .xlsx workbook.");
  const eocd = findEocd(dv, buf.byteLength);
  if (eocd < 0) throw new Error("The workbook is damaged (no zip directory).");
  const n = dv.getUint16(eocd + 10, true),
    cdOff = dv.getUint32(eocd + 16, true);
  if (n > LIMITS.MAX_ENTRIES) throw new Error(`The workbook has ${n} internal parts. The limit is ${LIMITS.MAX_ENTRIES}.`);
  let p = cdOff,
    total = 0;
  const names: string[] = [];
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== 0x02014b50) throw new Error("The workbook is damaged.");
    total += dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true),
      el = dv.getUint16(p + 30, true),
      cl = dv.getUint16(p + 32, true);
    if (p + 46 + nl > buf.byteLength) throw new Error("The workbook is damaged.");
    names.push(dec.decode(new Uint8Array(buf, p + 46, nl)));
    p += 46 + nl + el + cl;
  }
  if (total > LIMITS.MAX_UNZIPPED || total / buf.byteLength > LIMITS.MAX_RATIO) throw new Error("The workbook expands to an unsafe size (possible zip bomb). It was not opened.");
  if (names.some((x) => /vbaProject\.bin$/i.test(x) || /(^|\/)activeX\//i.test(x)))
    throw new Error("The workbook contains macros or ActiveX controls. Save it as a plain .xlsx without macros and upload again.");
  if (names.some((x) => x.startsWith("/") || x.includes("\\") || x.split("/").includes(".."))) throw new Error("The workbook has unsafe internal paths. It was not opened.");
}

export function zipEntries(buf: ArrayBuffer): Map<string, ZipEntry> {
  const dv = new DataView(buf);
  const eocd = findEocd(dv, buf.byteLength);
  if (eocd < 0) throw new Error("The workbook is damaged (no zip directory).");
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, ZipEntry>();
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== 0x02014b50) throw new Error("The workbook is damaged.");
    const method = dv.getUint16(p + 10, true),
      csize = dv.getUint32(p + 20, true),
      usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true),
      el = dv.getUint16(p + 30, true),
      cl = dv.getUint16(p + 32, true),
      off = dv.getUint32(p + 42, true);
    if (p + 46 + nl > buf.byteLength || off + 30 > buf.byteLength) throw new Error("The workbook is damaged.");
    out.set(dec.decode(new Uint8Array(buf, p + 46, nl)), { method, csize, usize, off });
    p += 46 + nl + el + cl;
  }
  return out;
}

/** Streams decompression and stops as soon as output passes the declared size (defeats lying-size zip bombs). */
export async function readEntry(buf: ArrayBuffer, e: ZipEntry): Promise<string> {
  const dv = new DataView(buf);
  const nl = dv.getUint16(e.off + 26, true),
    el = dv.getUint16(e.off + 28, true);
  const start = e.off + 30 + nl + el;
  if (start + e.csize > buf.byteLength) throw new Error("The workbook is damaged.");
  const data = new Uint8Array(buf, start, e.csize);
  if (e.method === 0) return dec.decode(data);
  if (e.method !== 8) throw new Error("The workbook uses an unsupported compression method.");
  const limit = Math.min(LIMITS.MAX_PART, e.usize + 1024);
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      throw new Error("A workbook part expands beyond its declared size (possible zip bomb). It was not opened.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return dec.decode(out);
}

/* ----- writer ----- */
const crcT = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflate(u8: Uint8Array): Promise<Uint8Array> {
  const cs = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(cs).arrayBuffer());
}
export async function zip(files: [string, string | Uint8Array][], mime: string): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let off = 0;
  for (const [name, content] of files) {
    const nm = enc.encode(name),
      raw = typeof content === "string" ? enc.encode(content) : content,
      crc = crc32(raw),
      comp = await deflate(raw);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 8, true);
    lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(lh.buffer), nm, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 8, true);
    ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, nm.length, true);
    ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + comp.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)] as BlobPart[], { type: mime });
}
