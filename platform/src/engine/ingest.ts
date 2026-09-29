/* Upload reading: size and type checks, hashing, CSV/XLSX parsing, sheet and header-row detection. */
import { readXlsx, type Cell } from "./xlsx/reader";
import { LIMITS } from "./xlsx/zip";
import { cleanText } from "./cases";
import { autoMap, scoreHeaders, type ColumnMap, type Row } from "./mapping";

export const MAX_ROWS = 500000;

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Row[];
  score: number;
  headerRow: number;
}
export interface ParsedUpload {
  name: string;
  size: number;
  sha256: string;
  sheets: ParsedSheet[];
  sheetIdx: number;
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    f = "",
    q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(f);
      f = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
      if (rows.length > MAX_ROWS + 1) break;
    } else f += ch;
    if (f.length > 32768) throw new Error("A CSV field is longer than 32 KB. Check the file.");
  }
  if (f !== "" || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x !== ""));
}

/** Header names are cleaned and made unique so no column silently overwrites another. Case matters (`priority` ≠ `Priority`). */
function uniqueHeaders(raw: unknown[]): string[] {
  const seen = new Map<string, number>();
  return raw.slice(0, 200).map((v, i) => {
    let h = v == null || v === "" ? `Column ${i + 1}` : cleanText(v, 200).trim() || `Column ${i + 1}`;
    if (h === "__row") h = "__row (column)";
    const k = h;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    if (n) h = `${h} (${n + 1})`;
    return h;
  });
}

function toRows(headers: string[], data: Cell[][] | string[][], startIdx: number, firstRowNo: number): Row[] {
  const rows: Row[] = [];
  for (let r = startIdx; r < data.length && rows.length < MAX_ROWS; r++) {
    const v = data[r] || [];
    const o: Row = Object.create(null);
    let any = false;
    headers.forEach((h, i) => {
      const x = v[i];
      o[h] = x === undefined || x === "" ? null : x;
      if (o[h] !== null) any = true;
    });
    if (any) {
      o.__row = firstRowNo + (r - startIdx);
      rows.push(o);
    }
  }
  return rows;
}

export function checkFileMeta(name: string, size: number): void {
  if (!/\.(xlsx|csv)$/i.test(name)) throw new Error(`“${name}” isn't supported. Upload a .xlsx or .csv export. Macro-enabled (.xlsm) and legacy .xls files are refused.`);
  if (size > LIMITS.MAX_BYTES) throw new Error(`“${name}” is ${(size / 1048576).toFixed(1)} MB. The limit is ${LIMITS.MAX_BYTES / 1048576} MB.`);
  if (size === 0) throw new Error(`“${name}” is empty.`);
}

export async function parseUpload(name: string, buf: ArrayBuffer): Promise<ParsedUpload> {
  checkFileMeta(name, buf.byteLength);
  const sha256 = await sha256Hex(buf);
  const sheets: ParsedSheet[] = [];
  if (/\.csv$/i.test(name)) {
    const text = new TextDecoder("utf-8").decode(buf).replace(/^\uFEFF/, "");
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error("The CSV has no data rows.");
    if (rows[0].length > 200) throw new Error("The CSV has more than 200 columns. Remove unused columns and try again.");
    const headers = uniqueHeaders(rows[0]);
    sheets.push({ name: "CSV", headers, rows: toRows(headers, rows, 1, 2), score: scoreHeaders(headers), headerRow: 1 });
  } else {
    const raw = await readXlsx(buf);
    for (const ws of raw) {
      if (ws.rows.length < 2) continue;
      // The header is the best-scoring of the first five rows (exports sometimes carry a title row).
      let best = { score: -1, row: 0, headers: [] as string[] };
      for (let r = 0; r < Math.min(5, ws.rows.length); r++) {
        const hs = uniqueHeaders(Array.from(ws.rows[r] || [], (v) => v));
        const sc = scoreHeaders(hs);
        if (sc > best.score) best = { score: sc, row: r, headers: hs };
      }
      sheets.push({ name: ws.name, headers: best.headers, rows: toRows(best.headers, ws.rows, best.row + 1, best.row + 2), score: best.score, headerRow: best.row + 1 });
    }
    if (!sheets.length) throw new Error("No sheet with data was found in the workbook.");
  }
  let idx = 0;
  sheets.forEach((s, i) => {
    if (s.score > sheets[idx].score || (s.score === sheets[idx].score && s.rows.length > sheets[idx].rows.length)) idx = i;
  });
  return { name, size: buf.byteLength, sha256, sheets, sheetIdx: idx };
}

export function suggestMapping(sheet: ParsedSheet, saved?: ColumnMap | null) {
  return autoMap(sheet.headers, sheet.rows, saved);
}
