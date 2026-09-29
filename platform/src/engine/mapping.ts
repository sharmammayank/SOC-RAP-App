/* Column mapping to the canonical schema (spec §4.4). */

export interface FieldDef {
  k: string;
  label: string;
  req?: boolean;
  syn: string[];
  numeric?: boolean;
  text?: boolean;
  help?: string;
}

export const FIELDS: FieldDef[] = [
  { k: "id", label: "Case ID", req: true, syn: ["id", "caseid", "case", "ticketid", "ticket", "number", "incidentid"] },
  { k: "title", label: "Alert title", req: true, syn: ["title", "alertname", "alert", "name", "summary", "rulename"], help: "Used for rule-based categorization" },
  { k: "description", label: "Description", syn: ["description", "details"], help: "Optional second match field" },
  { k: "priorityScore", label: "Priority score", syn: ["priority", "priorityscore", "severityscore", "score"], numeric: true, help: "100, 80, 60, 40 or -1" },
  { k: "priorityLabel", label: "Priority label", syn: ["priority", "prioritylabel", "severity", "severitylabel"], text: true },
  { k: "createdAt", label: "Created", req: true, syn: ["createdat", "created", "createdtime", "creationtime", "time", "opened", "openedat"] },
  { k: "assignedAt", label: "Acknowledged (assigned)", syn: ["assignedat", "acknowledgedat", "ackat", "assigned"], help: "For TTA" },
  { k: "investigatedTill", label: "Investigation end", syn: ["investigatedtill", "investigatedat", "investigationend"], help: "For TTI" },
  { k: "containmentAt", label: "Contained", syn: ["containmentat", "containedat", "containment"], help: "For TTC" },
  { k: "closedAt", label: "Closed", syn: ["closedat", "closingtime", "resolvedat", "closed", "closetime"], help: "For TTR" },
  { k: "tta", label: "TTA seconds (supplied)", syn: ["timetoacknowledge", "tta"] },
  { k: "tti", label: "TTI seconds (supplied)", syn: ["timetoinvestigate", "tti"] },
  { k: "ttc", label: "TTC seconds (supplied)", syn: ["timetocontain", "ttc"] },
  { k: "ttr", label: "TTR seconds (supplied)", syn: ["timetoclose", "timetoresolve", "timetoremediate", "ttr"] },
  { k: "stage", label: "Stage", syn: ["stage", "status", "state"] },
  { k: "disposition", label: "Disposition", syn: ["disposition", "verdict"] },
  { k: "closeReason", label: "Close reason", syn: ["closereason"] },
  { k: "rootCause", label: "Root cause", syn: ["rootcause"] },
  { k: "assignee", label: "Assignee / tier", syn: ["userassigned", "assignee", "owner", "assignedto", "tier"] },
  { k: "isClosed", label: "Closed flag", syn: ["iscaseclosed", "isclosed"] },
];

export type ColumnMap = Record<string, string | undefined>;
export type Row = Record<string, unknown>;

/** Header comparison key: lowercase letters and digits, ignoring a de-duplication suffix such as " (2)". */
export const headerKey = (s: unknown) => String(s).replace(/ \(\d+\)$/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

export interface MapSuggestion {
  map: ColumnMap;
  /** 1 = exact name match, 0.7 = synonym match, 0.4 = loose (contains) match. */
  confidence: Record<string, number>;
}

export function autoMap(headers: string[], rows: Row[], saved?: ColumnMap | null): MapSuggestion {
  const used = new Set<string>(),
    map: ColumnMap = {},
    confidence: Record<string, number> = {};
  const sample = (h: string) => rows.slice(0, 50).map((r) => r[h]).filter((v) => v !== null && v !== undefined && v !== "");
  const isNumeric = (h: string) => {
    const v = sample(h);
    return v.length > 0 && v.every((x) => typeof x === "number" || /^-?\d+(\.\d+)?$/.test(String(x).trim()));
  };
  const fits = (f: FieldDef, h: string) => (!f.numeric || isNumeric(h)) && (!f.text || !isNumeric(h));
  // A saved client profile wins wherever its column is still present.
  if (saved) {
    for (const f of FIELDS) {
      const h = saved[f.k];
      if (h && headers.includes(h) && !used.has(h)) {
        map[f.k] = h;
        used.add(h);
        confidence[f.k] = 1;
      }
    }
  }
  for (const f of FIELDS) {
    if (map[f.k]) continue;
    for (let si = 0; si < f.syn.length; si++) {
      const s = f.syn[si];
      const h = headers.find((x) => !used.has(x) && headerKey(x) === s && fits(f, x));
      if (h) {
        map[f.k] = h;
        used.add(h);
        confidence[f.k] = si === 0 || headerKey(h) === headerKey(f.k) ? 1 : 0.7;
        break;
      }
    }
    if (!map[f.k] && f.req) {
      const h = headers.find((x) => !used.has(x) && f.syn.some((s) => s.length > 3 && headerKey(x).includes(s)) && fits(f, x));
      if (h) {
        map[f.k] = h;
        used.add(h);
        confidence[f.k] = 0.4;
      }
    }
  }
  return { map, confidence };
}

export function missingRequired(map: ColumnMap): string[] {
  return FIELDS.filter((f) => f.req && !map[f.k]).map((f) => f.label);
}

/** How well a header row matches the schema; used to pick the sheet and header row. */
export function scoreHeaders(headers: string[]): number {
  const keys = new Set(headers.map(headerKey));
  return FIELDS.reduce((a, f) => a + (f.syn.some((s) => keys.has(s)) ? 1 : 0), 0);
}
