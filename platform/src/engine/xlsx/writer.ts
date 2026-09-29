/* Dependency-free XLSX writer (ported from the MVP). Every string is XML-escaped and neutralized against formula injection. */
import { zip } from "./zip";

export type OutCell = string | number | boolean | null | undefined | { v: string | number | boolean | null; s?: number };
export interface OutSheet {
  name: string;
  rows: OutCell[][];
  widths?: number[];
  header?: boolean;
  filter?: boolean;
}

/** Style ids: 0 normal · 1 header · 2 good · 3 bad · 4 bold · 5..10 heat levels (light → dark) · 11 warn */
export const ST = { normal: 0, header: 1, good: 2, bad: 3, bold: 4, heat0: 5, warn: 11 } as const;
const HEAT = ["EAF2FC", "C6DCF6", "9EC5F4", "5598E7", "256ABF", "104281"];
export const HEAT_LEVELS = HEAT.length;

export const xmlEsc = (s: string) =>
  String(s)
    // eslint-disable-next-line no-control-regex -- characters XML 1.0 forbids are removed
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** CWE-1236: text starting with = + - @ (or full-width forms, tab, CR, LF) is prefixed with an apostrophe. */
export const neutralize = (v: string) => (/^[=+\-@\t\r\n＝＋－＠]/.test(v) ? "'" + v : v);

function colName(i: number) {
  let s = "";
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}
function stylesXml() {
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FF002855"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE5F3E5"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFBE8E8"/></patternFill></fill>',
    ...HEAT.map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/></patternFill></fill>`),
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFDF2D8"/></patternFill></fill>',
  ];
  const fonts = [
    '<font><sz val="11"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><name val="Calibri"/></font>',
    '<font><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',
  ];
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
    '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>',
    '<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>',
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    ...HEAT.map((_, i) => `<xf numFmtId="0" fontId="${i >= 3 ? 3 : 0}" fillId="${5 + i}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`),
    `<xf numFmtId="0" fontId="0" fillId="${5 + HEAT.length}" borderId="0" xfId="0" applyFill="1"/>`,
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}
function sheetXml(sh: OutSheet) {
  const parts: string[] = [];
  sh.rows.forEach((r, ri) => {
    let cells = "";
    r.forEach((cell, ci) => {
      let v: unknown = cell,
        st = 0;
      if (cell && typeof cell === "object") {
        v = cell.v;
        st = cell.s || 0;
      }
      if (ri === 0 && sh.header !== false) st = 1;
      const ref = colName(ci) + (ri + 1),
        sa = st ? ` s="${st}"` : "";
      if (v === null || v === undefined || v === "") {
        if (st) cells += `<c r="${ref}"${sa}/>`;
      } else if (typeof v === "number" && Number.isFinite(v)) cells += `<c r="${ref}"${sa}><v>${v}</v></c>`;
      else if (typeof v === "boolean") cells += `<c r="${ref}"${sa} t="b"><v>${v ? 1 : 0}</v></c>`;
      else cells += `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(neutralize(String(v)).slice(0, 32000))}</t></is></c>`;
    });
    parts.push(`<row r="${ri + 1}">${cells}</row>`);
  });
  const ncol = Math.max(1, ...sh.rows.map((r) => r.length));
  const cols = sh.widths ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const pane = sh.header !== false ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
  const af = sh.filter ? `<autoFilter ref="A1:${colName(ncol - 1)}${sh.rows.length}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${parts.join("")}</sheetData>${af}</worksheet>`;
}

export async function writeXlsx(sheets: OutSheet[], meta: { title?: string } = {}): Promise<Blob> {
  const used = new Set<string>();
  const names = sheets.map((s) => {
    let n = s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
    let k = 2;
    while (used.has(n.toLowerCase())) n = `${n.slice(0, 28)} ${k++}`;
    used.add(n.toLowerCase());
    return xmlEsc(n);
  });
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ],
    [
      "docProps/core.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(meta.title || "SOC report")}</dc:title><dc:creator>SOC-RAP</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    ["xl/styles.xml", stylesXml()],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)] as [string, string]),
  ];
  return zip(files, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

/** CSV with the same formula neutralization, for "CSV export on every grid". */
export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  const q = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? neutralize(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n");
}
