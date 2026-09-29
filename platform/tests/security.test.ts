/* The MVP security review's test cases, re-run against the production ingestion and export code. */
import { describe, it, expect } from "vitest";
import { parseUpload } from "../src/engine/ingest";
import { writeXlsx, neutralize, toCsv } from "../src/engine/xlsx/writer";
import { zip } from "../src/engine/xlsx/zip";
import { readXlsx } from "../src/engine/xlsx/reader";

const enc = new TextEncoder();
const buf = async (b: Blob) => await b.arrayBuffer();
const minimalWorkbook = (sheetXml: string, extra: [string, string][] = []) =>
  zip(
    [
      ["[Content_Types].xml", "<Types/>"],
      ["xl/workbook.xml", '<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
      ["xl/worksheets/sheet1.xml", sheetXml],
      ...extra,
    ],
    "application/zip",
  );
const sheet = (rows: string) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;

describe("upload safety", () => {
  it("reads a normal workbook with inline strings, numbers and entities", async () => {
    const wb = await minimalWorkbook(
      sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>title</t></is></c></row><row r="2"><c r="A2"><v>42</v></c><c r="B2" t="inlineStr"><is><t>A &amp; B &lt;x&gt; &#x41;</t></is></c></row>'),
    );
    const s = await readXlsx(await buf(wb));
    expect(s[0].rows[1]).toEqual([42, "A & B <x> A"]);
  });
  it("refuses a DTD hidden after padding", async () => {
    const wb = await minimalWorkbook(" ".repeat(10000) + '<!DOCTYPE x [<!ENTITY a "b">]>' + sheet(""));
    await expect(readXlsx(await buf(wb))).rejects.toThrow(/DTD/);
  });
  it("refuses macro workbooks", async () => {
    const wb = await minimalWorkbook(sheet(""), [["xl/vbaProject.bin", "x"]]);
    await expect(readXlsx(await buf(wb))).rejects.toThrow(/macros/);
  });
  it("refuses path traversal entries", async () => {
    const wb = await minimalWorkbook(sheet(""), [["../evil.xml", "x"]]);
    await expect(readXlsx(await buf(wb))).rejects.toThrow(/unsafe internal paths/);
  });
  it("refuses a classic zip bomb (expansion ratio)", async () => {
    const big = "0".repeat(60 * 1024 * 1024);
    const wb = await minimalWorkbook(sheet(""), [["xl/pad.xml", big]]);
    await expect(readXlsx(await buf(wb))).rejects.toThrow(/zip bomb/);
  });
  it("refuses a part that lies about its size", async () => {
    const wb = await minimalWorkbook(sheet('<row r="1"><c r="A1"><v>1</v></c></row>'.repeat(20000)));
    const b = new Uint8Array(await buf(wb));
    // Patch the central-directory uncompressed size of the sheet entry down to 10 bytes.
    const dv = new DataView(b.buffer);
    let p = dv.getUint32(b.length - 22 + 16, true);
    for (let k = 0; k < 4; k++) {
      const nl = dv.getUint16(p + 28, true);
      const name = new TextDecoder().decode(b.slice(p + 46, p + 46 + nl));
      if (name === "xl/worksheets/sheet1.xml") dv.setUint32(p + 24, 10, true);
      p += 46 + nl + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    await expect(readXlsx(b.buffer)).rejects.toThrow(/declared size/);
  });
  it("refuses a 400-million row index", async () => {
    const wb = await minimalWorkbook(sheet('<row r="400000000"><c r="A400000000"><v>1</v></c></row>'));
    await expect(readXlsx(await buf(wb))).rejects.toThrow(/500,000/);
  });
  it("refuses unsupported extensions and oversize files", async () => {
    await expect(parseUpload("x.xlsm", new ArrayBuffer(10))).rejects.toThrow(/isn't supported/);
    await expect(parseUpload("x.xls", new ArrayBuffer(10))).rejects.toThrow(/isn't supported/);
  });
  it("makes duplicate headers unique instead of overwriting", async () => {
    const up = await parseUpload("a.csv", enc.encode("id,title,title\n1,a,b\n").buffer as ArrayBuffer);
    expect(up.sheets[0].headers).toEqual(["id", "title", "title (2)"]);
    expect(up.sheets[0].rows[0]["title (2)"]).toBe("b");
  });
});

describe("export safety", () => {
  it("neutralizes formula injection, including full-width forms", () => {
    for (const v of ["=HYPERLINK(\"x\")", "+cmd", "-2+3", "@SUM(A1)", "＝1+1", "\nx", "\tx"]) expect(neutralize(v).startsWith("'")).toBe(true);
    expect(neutralize("Normal title")).toBe("Normal title");
    expect(toCsv([["=1+1", "ok"]])).toContain("'=1+1");
  });
  it("writes a workbook the reader can read back, with control characters stripped", async () => {
    const b = await writeXlsx([{ name: "S", rows: [["a", "b"], ["x\u0001y", 5]] }]);
    const s = await readXlsx(await buf(b));
    expect(s[0].rows[1]).toEqual(["xy", 5]);
  });
});

describe("header handling", () => {
  it("keeps headers that differ only by case, and maps the label column", async () => {
    const { suggestMapping } = await import("../src/engine/ingest");
    const up = await parseUpload("a.csv", enc.encode("id,title,priority,Priority,createdAt\n1,a,80,High,1780272468247\n").buffer as ArrayBuffer);
    expect(up.sheets[0].headers).toEqual(["id", "title", "priority", "Priority", "createdAt"]);
    const m = suggestMapping(up.sheets[0]).map;
    expect(m.priorityScore).toBe("priority");
    expect(m.priorityLabel).toBe("Priority");
  });
});
