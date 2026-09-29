/* Spec v2.0 §9.1 acceptance tests that the engine can prove on its own (UI-level ones are covered by the engine behaviour they depend on). */
import { describe, it, expect } from "vitest";
import { buildCases } from "../src/engine/cases";
import { computeRun } from "../src/engine/run";
import { classify, compileRules, seedRules, regressionTest, categoryDiff, checkPattern, normTitle, suggestPattern } from "../src/engine/rules";
import { DEFAULT_LIMITS, DEFAULT_TARGETS, makeCell, limitError } from "../src/engine/defaults";
import { DEFAULT_SETTINGS, type Edit, type Rule } from "../src/engine/types";
import { heatmap, observations, DEFAULT_MATERIALITY, cellCases } from "../src/engine/analytics";
import { periodRange } from "../src/engine/periods";
import type { Row } from "../src/engine/mapping";

const MAP = { id: "id", title: "title", priorityScore: "priority", createdAt: "createdAt", assignedAt: "assignedAt", closedAt: "closedAt", disposition: "disposition" };
const T0 = Date.UTC(2026, 5, 10, 9, 0, 0);
const row = (id: string, title: string, priority: number | null, ackMin: number | null, closeMin: number | null, extra: Partial<Row> = {}): Row => ({
  id,
  title,
  priority,
  createdAt: T0,
  assignedAt: ackMin == null ? null : T0 + ackMin * 60000,
  closedAt: closeMin == null ? null : T0 + closeMin * 60000,
  disposition: "True Positive",
  ...extra,
});
const period = { cadence: "monthly" as const, start: "2026-06-01", end: "2026-06-30" };
const run = (rows: Row[], o: { edits?: Edit[]; limits?: typeof DEFAULT_LIMITS; rules?: Rule[] } = {}) =>
  computeRun({ cases: buildCases(rows, MAP, "UTC"), edits: o.edits ?? [], limits: o.limits ?? DEFAULT_LIMITS, targets: DEFAULT_TARGETS, rules: o.rules ?? seedRules(), settings: { ...DEFAULT_SETTINGS, periodTz: "UTC" }, period });
const { compiled } = compileRules(seedRules());

describe("spec §9.1 acceptance", () => {
  it("AT-01: 30 minutes and 1800 seconds normalize to the same limit and outcomes", () => {
    const a = makeCell(30, "min"),
      b = makeCell(1800, "s");
    expect(a.seconds).toBe(1800);
    expect(b.seconds).toBe(1800);
    const rows = [row("1", "CrowdStrike x", 100, 29, 60), row("2", "CrowdStrike y", 100, 31, 60), row("3", "CrowdStrike z", 100, 30, 60)];
    const l1 = structuredClone(DEFAULT_LIMITS),
      l2 = structuredClone(DEFAULT_LIMITS);
    l1.Critical.TTA = a;
    l2.Critical.TTA = b;
    const r1 = run(rows, { limits: l1 }).derived.map((d) => d.ev.TTA.s);
    const r2 = run(rows, { limits: l2 }).derived.map((d) => d.ev.TTA.s);
    expect(r1).toEqual(["MET", "NOT_MET", "MET"]);
    expect(r2).toEqual(r1);
    expect(limitError(0.5, "s")).toMatch(/whole number/);
  });

  it("AT-02: Informational rows are NOT APPLICABLE and absent from every denominator", () => {
    const out = run([row("1", "Proofpoint a", -1, 5, 10), row("2", "Proofpoint b", 80, 5, 10)]);
    const info = out.derived.find((d) => d.caseId === "1")!;
    expect(Object.values(info.ev).every((r) => r.s === "NA")).toBe(true);
    expect(out.agg.evaluable).toBe(1);
    expect(out.agg.total).toBe(2);
    expect(out.agg.overall.TTA.n).toBe(1);
    expect(out.issues.filter((i) => i.rows.includes(info.rowNo))).toEqual([]);
  });

  it("AT-03: mixed-case Proofpoint is categorized with the matched text recorded", () => {
    const c = classify("ALERT from PrOoFpOiNt TAP", compiled);
    expect(c.category).toBe("Proofpoint");
    expect(c.match).toBe("proofpoint");
  });

  it("AT-04: account_lockouts detected on DC01 → Windows Event", () => {
    const c = classify("account_lockouts detected on DC01", compiled);
    expect(c.category).toBe("Windows Event");
    expect(c.ruleId).toBe("CAT-WINE-01");
  });

  it("AT-05: a title matching no rule is Uncategorized and grouped in the queue", () => {
    const out = run([row("1", "Weekly ticket triage follow-up for ref 88213", 80, 5, 10), row("2", "Weekly ticket triage follow up for ref 88213", 80, 5, 10)]);
    expect(out.derived.every((d) => d.category === "Uncategorized")).toBe(true);
    const u = out.issues.filter((i) => i.type === "UNCAT");
    expect(u).toHaveLength(1);
    expect(u[0].rows).toHaveLength(2);
    expect(u[0].blocking).toBe(false);
  });

  it("AT-06: CrowdStrike beats Azure on precedence; the Azure match is in the audit trail", () => {
    const c = classify("CrowdStrike alert on Azure-hosted jump server", compiled, { audit: true });
    expect(c.category).toBe("CrowdStrike");
    expect(c.alsoMatched).toContain("CAT-AZUR-01");
  });

  it("AT-07: a blocking exception is reported and counted", () => {
    const out = run([row("1", "CrowdStrike a", null, 5, 10), row("2", "CrowdStrike b", 80, 5, 10)]);
    expect(out.counts.blockingOpen).toBe(1);
    expect(out.issues.find((i) => i.blocking)!.type).toBe("PRIO");
  });

  it("AT-08: editing an invalid timestamp re-evaluates the case", () => {
    const rows = [row("1", "CrowdStrike a", 80, 30, 20)]; // closed before acknowledged
    const before = run(rows);
    expect(before.issues.map((i) => i.type)).toContain("CHRONO");
    expect(before.derived[0].ev.TTA.s).toBe("ERROR");
    const fix: Edit = { kind: "timestamp", rowNo: before.derived[0].rowNo, field: "assignedAt", value: T0 + 10 * 60000 };
    const after = run(rows, { edits: [fix] });
    expect(after.issues.filter((i) => i.blocking)).toEqual([]);
    expect(after.derived[0].ev.TTA).toMatchObject({ s: "MET", el: 600 });
  });

  it("AT-09: heatmaps re-render for a new window from the same calculated cases", () => {
    const rows = [row("1", "CrowdStrike a", 80, 5, 10), row("2", "CrowdStrike b", 80, 5, 10, { createdAt: Date.UTC(2026, 5, 20, 22) })];
    const out = run(rows);
    const o = { kind: "volumeByHour" as const, granularity: "hour" as const, displayTz: "UTC", periodTz: "UTC", topN: 10 };
    const all = heatmap(out.derived, o, periodRange(period, "UTC"));
    expect(all.total).toBe(2);
    const w = heatmap(out.derived, o, { from: Date.UTC(2026, 5, 15), to: Date.UTC(2026, 5, 25) });
    expect(w.total).toBe(1);
    const r = w.rows.indexOf("Sat"),
      c = w.cols.indexOf("22");
    expect(w.cells[r][c]).toBe(1);
    expect(cellCases(out.derived, w, r, c, { from: Date.UTC(2026, 5, 15), to: Date.UTC(2026, 5, 25) })).toHaveLength(1);
    // Empty cells are true zeros.
    expect(w.cells.flat().filter((v) => v === 0).length).toBe(7 * 24 - 1);
  });

  it("AT-10: comparison observations are traceable to computed values", () => {
    const cur = run([row("1", "CrowdStrike a", 80, 5, 10), row("2", "CrowdStrike b", 80, 5, 10), row("3", "Darktrace c", 80, 5, 10)]);
    const prev = run([row("9", "CrowdStrike a", 80, 5, 10)]);
    const obs = observations({ A: cur.agg, P: prev.agg, cur: cur.derived, curLabel: "June 2026", prevLabel: "May 2026", source: "SOC", displayTz: "UTC", tzLabel: "UTC", materiality: { ...DEFAULT_MATERIALITY, minAbs: 1, minPct: 1 } });
    const vol = obs.find((x) => x.kind === "volume")!;
    expect(vol.basis).toMatchObject({ current: 3, previous: 1, delta: 2 });
    expect(vol.text).toContain("an increase of 2 (+200.0%)");
    expect(obs.find((x) => x.kind === "emerging")!.text).toContain("Other (1)");
  });

  it("AT-11: rule-set publish runs the regression and shows category movements", () => {
    expect(regressionTest(seedRules())).toEqual([]);
    const next = [...seedRules(), { rule_id: "CAT-USER-01", category: "Ticketing", report_bucket: "Other", pattern: "\\bticket triage\\b", precedence: 50, sample_titles: ["Weekly ticket triage"] }];
    expect(regressionTest(next)).toEqual([]);
    const diff = categoryDiff(new Map([["Weekly ticket triage follow-up", 4], ["CrowdStrike x", 2]]), seedRules(), next);
    expect(diff).toEqual([expect.objectContaining({ from: "Uncategorized", to: "Ticketing", count: 4 })]);
    const broken = next.map((r) => (r.rule_id === "CAT-PFPT-01" ? { ...r, sample_titles: ["Darktrace model breach"] } : r));
    expect(regressionTest(broken)).toHaveLength(1);
  });

  it("AT-12: re-running with the recorded versions reproduces results exactly", () => {
    const rows = [row("1", "CrowdStrike a", 80, 5, 10), row("2", "Proofpoint b", 60, 500, 100000)];
    const a = run(rows),
      b = run(rows);
    expect(JSON.stringify(b.agg)).toBe(JSON.stringify(a.agg));
  });
});

describe("review edits", () => {
  it("duplicates block until one copy is dropped", () => {
    const rows = [row("7", "CrowdStrike a", 80, 5, 10), row("7", "CrowdStrike a", 80, 5, 10)];
    const a = run(rows);
    expect(a.issues.find((i) => i.type === "DUP")?.blocking).toBe(true);
    const b = run(rows, { edits: [{ kind: "drop", rowNo: a.derived[1].rowNo, reason: "duplicate" }] });
    expect(b.issues.find((i) => i.type === "DUP")).toBeUndefined();
    expect(b.agg.total).toBe(1);
  });
  it("out-of-period rows are flagged and excluded unless included", () => {
    const rows = [row("1", "CrowdStrike a", 80, 5, 10), row("2", "CrowdStrike b", 80, 5, 10, { createdAt: Date.UTC(2026, 6, 2) })];
    const a = run(rows);
    expect(a.issues.find((i) => i.type === "OUT")?.rows).toHaveLength(1);
    expect(a.agg.total).toBe(1);
    const b = run(rows, { edits: [{ kind: "period", rowNo: a.derived[1].rowNo, include: true }] });
    expect(b.agg.total).toBe(2);
  });
  it("a category assignment resolves the whole title group", () => {
    const rows = [row("1", "Mystery alert", 80, 5, 10), row("2", "mystery_alert", 80, 5, 10)];
    const out = run(rows, { edits: [{ kind: "category", norm: normTitle("Mystery alert"), category: "ServiceNow", bucket: "Other" }] });
    expect(out.derived.map((d) => d.category)).toEqual(["ServiceNow", "ServiceNow"]);
    expect(out.issues.filter((i) => i.type === "UNCAT")).toEqual([]);
  });
  it("open cases past the TTR limit are NOT MET, within it PENDING", () => {
    const out = run([row("1", "CrowdStrike a", 100, 5, null, { createdAt: Date.UTC(2026, 5, 1) }), row("2", "CrowdStrike b", 100, 5, 10, { createdAt: Date.UTC(2026, 5, 30, 23) })]);
    expect(out.derived[0].ev.TTR.s).toBe("NOT_MET");
  });
  it("prototype-like values are plain data", () => {
    const out = run([row("1", "CrowdStrike a", 80, 5, 10, { disposition: "__proto__" }), row("2", "CrowdStrike b", 80, 5, 10, { disposition: "constructor" })]);
    expect(out.agg.disp["__proto__"]).toBe(1); // eslint-disable-line no-proto
    expect(out.agg.disp["constructor"]).toBe(1);
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("pattern safety (ReDoS gate)", () => {
  const bad = ["(a|aa)+$", "(\\w+\\s?)+$", "(a+)+", "(x*)*y", "(?=a)b", "(a)\\1", "a{10000}", "(.*a){20}", ".*.*x"];
  const good = ["\\bproof ?point\\b", "^(hd|oc)\\d+ cs\\b", "\\bforti ?(gate|net)\\b", "\\bcve \\d{4} \\d{4,7}\\b", "\\bsimulat(ed|ion)\\b"];
  it.each(bad)("rejects %s", (p) => expect(checkPattern(p)).not.toBeNull());
  it.each(good)("accepts %s", (p) => expect(checkPattern(p)).toBeNull());
  it("every seed rule passes the gate", () => expect(seedRules().map((r) => [r.rule_id, checkPattern(r.pattern)]).filter((x) => x[1])).toEqual([]));
});

describe("promote-to-rule suggestions", () => {
  it.each(["Quarterly vendor ticket follow up", "HD062_Unauthorized_PersonalVPN_Execution", "Email messages removed after delivery​", "the 42 of a x"])("suggested pattern for %s matches its own title", (t) => {
    const n = normTitle(t);
    const p = suggestPattern(n);
    if (!p) return;
    expect(checkPattern(p)).toBeNull();
    expect(new RegExp(p).test(n)).toBe(true);
  });
});
