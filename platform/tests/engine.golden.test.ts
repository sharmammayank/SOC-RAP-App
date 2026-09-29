import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parseUpload, suggestMapping } from "../src/engine/ingest";
import { buildCases } from "../src/engine/cases";
import { computeRun } from "../src/engine/run";
import { seedRules } from "../src/engine/rules";
import { DEFAULT_LIMITS, DEFAULT_TARGETS } from "../src/engine/defaults";
import { DEFAULT_SETTINGS, PRIORITIES } from "../src/engine/types";
import { fmtDur } from "../src/lib/format";
import mvp from "./fixtures/mvp-june-parity.json";

const load = async (f: string) => {
  const b = readFileSync(new URL("./fixtures/" + f, import.meta.url));
  const up = await parseUpload(f, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const sh = up.sheets[up.sheetIdx];
  const { map } = suggestMapping(sh);
  return buildCases(sh.rows, map, "UTC");
};
const run = (cases: Awaited<ReturnType<typeof load>>, start: string, end: string) =>
  computeRun({ cases, edits: [], limits: DEFAULT_LIMITS, targets: DEFAULT_TARGETS, rules: seedRules(), settings: { ...DEFAULT_SETTINGS, periodTz: "UTC" }, period: { cadence: "monthly", start, end } });

const has = existsSync(new URL("./fixtures/june.xlsx", import.meta.url)) && existsSync(new URL("./fixtures/july.xlsx", import.meta.url));

/* Reference: the MVP's verified June figures and the July 2026 service review deck (slide 4, 6, 7 show June; slide 8 shows July). */
describe.skipIf(!has)("golden: real exports vs the MVP and the reference deck", () => {
  it("June 2026 matches the MVP engine cell for cell", async () => {
    const A = run(await load("june.xlsx"), "2026-06-01", "2026-06-30").agg;
    const r = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);
    expect({ total: A.total, evaluable: A.evaluable, auto: A.auto, tier12: A.tier12, tier3: A.tier3, simulation: A.simulation, open: A.open, tp: A.tp }).toEqual({
      total: mvp.total, evaluable: mvp.evaluable, auto: mvp.auto, tier12: mvp.tier12, tier3: mvp.tier3, simulation: mvp.simulation, open: mvp.open, tp: mvp.tp,
    });
    expect({ ...A.bucket }).toEqual(mvp.bucket);
    expect({ ...A.closeR }).toEqual(mvp.closeR);
    for (const p of PRIORITIES)
      (["TTA", "TTI", "TTC", "TTR"] as const).forEach((m, i) => {
        const c = A.sla[p][m];
        expect([c.met, c.notMet, c.pending, c.na, c.err, c.zero, c.pct, r(c.mean), r(c.median), r(c.p95)], `${p} ${m}`).toEqual((mvp.sla as any)[p][i]);
      });
  });

  it("June 2026 matches the reference deck where the deck was computed (not hand-edited)", async () => {
    const out = run(await load("june.xlsx"), "2026-06-01", "2026-06-30");
    const A = out.agg;
    expect(A.total).toBe(3195);
    expect(A.evaluable).toBe(2631);
    expect(A.byPrio).toEqual({ Critical: 4, High: 461, Medium: 1122, Low: 1044, Informational: 564 });
    // Deck slide 4 KPI table (compliance and averages)
    const pct = Object.fromEntries(PRIORITIES.map((p) => [p, [A.sla[p].TTA.pct, A.sla[p].TTI.pct, A.sla[p].TTC.pct]]));
    // Deck shows High TTI 99.91% and Low TTC 100%; the engine (and MVP) give 98.92% and "no evaluable cases".
    expect(pct).toEqual({ Critical: [100, 100, 100], High: [99.78, 98.92, 100], Medium: [100, 100, 100], Low: [99.9, 100, null] });
    expect(fmtDur(A.sla.Critical.TTA.mean)).toBe("5.12 Min");
    expect(fmtDur(A.sla.High.TTA.mean)).toBe("47.53 Min"); // deck: 47.52 (rounded down by hand)
    expect(fmtDur(A.sla.Medium.TTA.mean)).toBe("5.62 Min");
    expect(fmtDur(A.sla.Low.TTA.mean)).toBe("11.20 Min"); // deck: 11.19
    expect(fmtDur(A.sla.Critical.TTI.mean)).toBe("40.95 Min");
    expect(fmtDur(A.sla.High.TTI.mean)).toBe("53.15 Min"); // deck: 53.14
    // Deck slide 7
    expect(A.open).toBe(23);
    expect(A.closeR.Maintenance).toBe(913);
    expect(out.counts.uncategorized).toBe(0);
    expect(out.counts.blockingOpen).toBe(0);
  });

  it("July 2026 total matches the deck (slide 8)", async () => {
    const out = run(await load("july.xlsx"), "2026-07-01", "2026-07-31");
    expect(out.agg.total).toBe(2572);
    const top = Object.entries(out.agg.heat).map(([t, a]) => [t, a.reduce((x, y) => x + y, 0)] as const).sort((a, b) => b[1] - a[1])[0];
    expect(top[1]).toBe(748);
  });
});
