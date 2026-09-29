/*
 * XLSX reader built on a small tokenizer instead of DOMParser, so it runs in Web Workers and Node.
 * It reads only what the app needs: sheet names, shared strings and cell values.
 */
import { inspectZip, readEntry, zipEntries } from "./zip";

export type Cell = string | number | boolean | null;
export interface RawSheet {
  name: string;
  rows: Cell[][];
}

const MAX_COLS = 16384,
  MAX_ROW_INDEX = 500010;

/** Refuses any DTD or entity declaration anywhere in the part (spec review finding 2). */
function guard(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("The workbook contains a DTD or entity declarations, which are refused for safety.");
  return xml;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] !== "#") return ENT[e];
    const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
  });
}
function attrs(s: string): Record<string, string> {
  const o: Record<string, string> = Object.create(null);
  const rx = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s))) o[m[1]] = decodeXml(m[2] ?? m[3] ?? "");
  return o;
}
/** All text in <t> elements (optionally prefixed), skipping phonetic runs. */
function textOf(inner: string): string {
  const noPh = inner.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  const rx = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?t\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(noPh))) out += m[1] ? decodeXml(m[1]) : "";
  return out;
}
function colIdx(ref: string): number {
  const m = /^([A-Z]{1,3})\d/.exec(ref || "");
  if (!m) throw new Error("The workbook has an invalid cell reference.");
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  if (n > MAX_COLS) throw new Error("The workbook has more columns than Excel allows.");
  return n - 1;
}

export async function readXlsx(buf: ArrayBuffer): Promise<RawSheet[]> {
  inspectZip(buf);
  const ents = zipEntries(buf);
  const get = async (name: string) => {
    const e = ents.get(name);
    return e ? guard(await readEntry(buf, e)) : null;
  };
  const wb = await get("xl/workbook.xml");
  if (!wb) throw new Error("This zip file isn't an Excel workbook.");
  const rels = (await get("xl/_rels/workbook.xml.rels")) ?? "";
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) relMap.set(a.Id, a.Target);
  }
  const ssXml = await get("xl/sharedStrings.xml");
  const ss: string[] = [];
  if (ssXml) for (const m of ssXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\s*\/>/g)) ss.push(m[1] ? textOf(m[1]) : "");
  const sheets: RawSheet[] = [];
  for (const m of wb.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    const rid = a["r:id"] ?? Object.entries(a).find(([k]) => /(^|:)id$/.test(k) && k !== "sheetId")?.[1];
    let target = rid ? relMap.get(rid) : undefined;
    if (!target || /^[a-z]+:/i.test(target) || target.includes("..")) continue;
    target = target.replace(/^\/?xl\//, "").replace(/^\//, "");
    const xml = await get("xl/" + target);
    if (!xml) continue;
    const rows: Cell[][] = [];
    const rowRx = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
    const cellRx = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRx.exec(xml))) {
      const ra = attrs(rm[1]);
      const ri = (parseInt(ra.r, 10) || rows.length + 1) - 1;
      if (ri < 0 || ri >= MAX_ROW_INDEX) throw new Error("The workbook has more rows than the 500,000 limit.");
      const arr: Cell[] = [];
      const inner = rm[2] ?? "";
      let cm: RegExpExecArray | null;
      cellRx.lastIndex = 0;
      while ((cm = cellRx.exec(inner))) {
        const ca = attrs(cm[1]);
        const i = ca.r ? colIdx(ca.r) : arr.length;
        const body = cm[2] ?? "";
        const vm = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);
        let v: Cell = vm ? decodeXml(vm[1]) : null;
        const t = ca.t;
        if (t === "s") v = v == null ? null : ss[parseInt(v as string, 10)] ?? null;
        else if (t === "inlineStr") v = textOf(body);
        else if (t === "b") v = v === "1";
        else if (t === "e") v = null;
        else if (t === "str") v = v as string | null;
        else if (v != null && v !== "") {
          const n = Number(v);
          v = Number.isFinite(n) ? n : (v as string);
        }
        arr[i] = v;
      }
      rows[ri] = arr;
    }
    sheets.push({ name: a.name ?? `Sheet${sheets.length + 1}`, rows: Array.from(rows, (x) => x || []) });
  }
  return sheets;
}
