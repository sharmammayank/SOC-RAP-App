import type { CaseRecord, Priority, TsField } from "./types";
import { ALL_PRIORITIES, TS_FIELDS } from "./types";
import { parseTs } from "./timestamps";
import type { ColumnMap, Row } from "./mapping";

export const cleanText = (s: unknown, max = 4000) =>
  String(s ?? "")
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1")
    .slice(0, max);

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Builds case records from mapped rows. `rowNo` is the 1-based spreadsheet row (header = row 1). */
export function buildCases(rows: Row[], map: ColumnMap, naiveTz: string, firstRowNo = 2): CaseRecord[] {
  const g = (r: Row, k: string) => (map[k] ? r[map[k]!] : undefined);
  return rows.map((r, i) => {
    const raw = {} as Record<TsField, unknown>,
      ts = {} as Record<TsField, number | null>;
    for (const k of TS_FIELDS) {
      const v = g(r, k);
      raw[k] = v instanceof Date ? v.toISOString() : v ?? null;
      ts[k] = parseTs(v, naiveTz).ms;
    }
    return {
      rowNo: typeof r.__row === "number" ? (r.__row as number) : firstRowNo + i,
      id: cleanText(g(r, "id"), 200).trim(),
      title: cleanText(g(r, "title"), 1000).trim(),
      description: cleanText(g(r, "description")),
      score: numOrNull(g(r, "priorityScore")),
      label: g(r, "priorityLabel") != null && g(r, "priorityLabel") !== "" ? cleanText(g(r, "priorityLabel"), 100).trim() : null,
      stage: cleanText(g(r, "stage"), 200),
      disposition: cleanText(g(r, "disposition"), 200).trim(),
      closeReason: cleanText(g(r, "closeReason"), 200).trim(),
      rootCause: cleanText(g(r, "rootCause"), 200),
      assignee: cleanText(g(r, "assignee"), 200),
      isClosedFlag: map.isClosed ? toBool(g(r, "isClosed")) : null,
      supplied: { TTA: numOrNull(g(r, "tta")), TTI: numOrNull(g(r, "tti")), TTC: numOrNull(g(r, "ttc")), TTR: numOrNull(g(r, "ttr")) },
      raw,
      ts,
    };
  });
}

export const SCORE_MAP: Record<string, Priority> = { "100": "Critical", "80": "High", "60": "Medium", "40": "Low", "-1": "Informational" };

/** Score ranges used when a score isn't one of the standard values (100/80/60/40/-1). */
export function scoreBand(n: number): Priority {
  if (n <= 0) return "Informational";
  if (n >= 90) return "Critical";
  if (n >= 70) return "High";
  if (n >= 50) return "Medium";
  return "Low";
}

/**
 * Priority from the score, falling back to the label, then to score bands. `note` explains any correction,
 * which the review queue shows as a non-blocking item. Only a blank or unreadable value returns null (blocking).
 */
export function resolvePriority(c: Pick<CaseRecord, "score" | "label">): { priority: Priority | null; note: string } {
  const lbl = c.label ? ALL_PRIORITIES.find((p) => p.toLowerCase() === c.label!.trim().toLowerCase()) : undefined;
  if (c.score !== null && !Number.isNaN(c.score)) {
    const exact = SCORE_MAP[String(c.score)];
    if (exact) return { priority: exact, note: lbl && lbl !== exact ? `Score ${c.score} = ${exact}; label said ${c.label}. Score used.` : "" };
    if (lbl) return { priority: lbl, note: `Score ${c.score} isn't a standard value; used the priority label (${lbl}).` };
    const band = scoreBand(c.score);
    return { priority: band, note: `Score ${c.score} isn't a standard value; mapped by range to ${band}.` };
  }
  if (lbl) return { priority: lbl, note: "" };
  return { priority: null, note: "" };
}
