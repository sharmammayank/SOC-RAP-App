/* Monthly service review deck (ported from the MVP). Charts are drawn as images in the reference style so they render in every viewer. */
import type { ReportInput } from "@/engine/export/workbook";
import { ALL_PRIORITIES, PRIORITIES, type Priority } from "@/engine/types";
import { fmtLimit } from "@/engine/defaults";
import { detectionInsights } from "@/engine/analytics";
import { tzAbbrev } from "@/engine/tz";
import { fmtDur, fmtInt, fmtPct } from "./format";
import { fmtYmd } from "@/engine/periods";

const DECK_FONT = '"Tw Cen MT","Century Gothic","Segoe UI",Arial,sans-serif';
const DK = { blue: "#0057B8", navy: "#002855", light: "#7BAFD4", amber: "#FFB500", char: "#373A36", grid: "#D9D9D9", axis: "#595959", ink: "#000000", sub: "#404040" };
type G = CanvasRenderingContext2D;
const font = (pt: number, bold?: boolean) => `${bold ? "700 " : ""}${pt}px ${DECK_FONT}`;

function deckCanvas(wIn: number, hIn: number, draw: (g: G, W: number, H: number) => void) {
  const dpi = 220,
    c = document.createElement("canvas");
  c.width = Math.round(wIn * dpi);
  c.height = Math.round(hIn * dpi);
  const g = c.getContext("2d")!;
  g.scale(dpi / 72, dpi / 72);
  g.fillStyle = "#FFFFFF";
  g.fillRect(0, 0, wIn * 72, hIn * 72);
  g.textBaseline = "middle";
  g.lineJoin = "round";
  draw(g, wIn * 72, hIn * 72);
  return c.toDataURL("image/png");
}
function niceStep(max: number, ticks = 5) {
  const raw = max / ticks,
    p = Math.pow(10, Math.floor(Math.log10(raw || 1))),
    n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function pattern(g: G, kind: string, fg: string, bg: string) {
  const t = document.createElement("canvas"),
    s = 24;
  t.width = t.height = s;
  const p = t.getContext("2d")!;
  p.scale(4, 4);
  p.fillStyle = bg;
  p.fillRect(0, 0, 6, 6);
  p.strokeStyle = fg;
  p.fillStyle = fg;
  if (kind === "wdDnDiag") {
    p.lineWidth = 2;
    for (let k = -6; k <= 12; k += 6) {
      p.beginPath();
      p.moveTo(k, 0);
      p.lineTo(k + 6, 6);
      p.stroke();
    }
  } else if (kind === "ltUpDiag") {
    p.lineWidth = 0.8;
    for (let k = -6; k <= 12; k += 3) {
      p.beginPath();
      p.moveTo(k, 6);
      p.lineTo(k + 6, 0);
      p.stroke();
    }
  } else if (kind === "pct40") for (let y = 0; y < 6; y += 1.5) for (let x = ((y / 1.5) % 2) * 1.5; x < 6; x += 3) p.fillRect(x, y, 1.1, 1.1);
  const pat = g.createPattern(t, "repeat")!;
  pat.setTransform(new DOMMatrix().scale(0.25));
  return pat;
}
const SEV_STYLE: Record<Priority, { solid?: string; pat?: string; fg?: string; bg?: string }> = {
  Critical: { solid: "#3D586A" },
  High: { pat: "wdDnDiag", fg: DK.blue, bg: "#FFFFFF" },
  Medium: { pat: "ltUpDiag", fg: DK.char, bg: "#FFFFFF" },
  Low: { solid: DK.navy },
  Informational: { pat: "pct40", fg: "#BFC9D5", bg: DK.blue },
};
const sevFill = (g: G, n: Priority) => SEV_STYLE[n].solid || pattern(g, SEV_STYLE[n].pat!, SEV_STYLE[n].fg!, SEV_STYLE[n].bg!);
function legendRow(g: G, items: [string, string | CanvasPattern, boolean?][], cx: number, y: number) {
  g.font = font(9);
  const total = items.reduce((a, [n]) => a + 14 + g.measureText(n).width + 14, 0);
  let x = cx - total / 2;
  for (const [n, fill, line] of items) {
    if (line) {
      g.strokeStyle = fill as string;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 12, y);
      g.stroke();
    } else {
      g.fillStyle = fill;
      g.fillRect(x + 1, y - 4, 8, 8);
    }
    g.fillStyle = DK.sub;
    g.textAlign = "left";
    g.fillText(n, x + 14, y);
    x += 14 + g.measureText(n).width + 14;
  }
}
function drawFunnel(rows: [number, string, string][]) {
  return deckCanvas(4.3, 1.75, (g, W, H) => {
    const n = rows.length,
      top = 4,
      rowH = (H - 8) / n,
      wTop = 150,
      wBot = 62,
      cx = 78,
      labX = 170;
    rows.forEach(([v, label, color], i) => {
      const w0 = wTop - ((wTop - wBot) * i) / n,
        w1 = wTop - ((wTop - wBot) * (i + 1)) / n,
        y0 = top + i * rowH,
        y1 = y0 + rowH - 1.2;
      g.fillStyle = "#" + color;
      g.beginPath();
      g.moveTo(cx - w0 / 2, y0);
      g.lineTo(cx + w0 / 2, y0);
      g.lineTo(cx + w1 / 2, y1);
      g.lineTo(cx - w1 / 2, y1);
      g.closePath();
      g.fill();
      g.fillStyle = "#FFFFFF";
      g.font = font(10, true);
      g.textAlign = "center";
      g.fillText(fmtInt(v), cx, (y0 + y1) / 2 + 0.5);
      const edge = cx + (w0 + w1) / 4;
      g.strokeStyle = "#595959";
      g.lineWidth = 0.6;
      g.setLineDash([1.6, 1.6]);
      g.beginPath();
      g.moveTo(edge + 2, (y0 + y1) / 2);
      g.lineTo(labX - 3, (y0 + y1) / 2);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = DK.ink;
      g.font = font(8.5);
      g.textAlign = "left";
      g.fillText(label, labX, (y0 + y1) / 2 + 0.5, W - labX - 2);
    });
  });
}
function drawSeverity(counts: Record<Priority, number>) {
  return deckCanvas(6.7, 5.5, (g, W, H) => {
    const m = { l: 40, r: 10, t: 18, b: 44 },
      pw = W - m.l - m.r,
      ph = H - m.t - m.b;
    const max = Math.max(1, ...ALL_PRIORITIES.map((p) => counts[p])),
      step = niceStep(max * 1.08),
      top = Math.ceil((max * 1.08) / step) * step;
    const y = (v: number) => m.t + ph - (v / top) * ph;
    g.font = font(9);
    g.textAlign = "right";
    for (let v = 0; v <= top + 1e-9; v += step) {
      g.strokeStyle = DK.grid;
      g.lineWidth = 0.6;
      g.beginPath();
      g.moveTo(m.l, y(v));
      g.lineTo(W - m.r, y(v));
      g.stroke();
      g.fillStyle = DK.axis;
      g.fillText(fmtInt(v), m.l - 5, y(v));
    }
    const slot = pw / ALL_PRIORITIES.length,
      bw = slot * 0.56;
    ALL_PRIORITIES.forEach((p, i) => {
      const v = counts[p],
        x = m.l + slot * i + (slot - bw) / 2,
        yy = y(v);
      g.fillStyle = sevFill(g, p);
      g.fillRect(x, yy, bw, m.t + ph - yy);
      if (SEV_STYLE[p].pat && v) {
        g.strokeStyle = SEV_STYLE[p].fg!;
        g.lineWidth = 0.6;
        g.strokeRect(x, yy, bw, m.t + ph - yy);
      }
      g.fillStyle = DK.sub;
      g.font = font(10.5);
      g.textAlign = "center";
      g.fillText(fmtInt(v), x + bw / 2, yy - 8);
    });
    g.strokeStyle = "#BFBFBF";
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(m.l, m.t + ph);
    g.lineTo(W - m.r, m.t + ph);
    g.stroke();
    legendRow(g, ALL_PRIORITIES.map((p) => [p, sevFill(g, p)]), m.l + pw / 2, H - 14);
  });
}
function drawCategories(items: { k: string; v: number }[]) {
  const rows = items.slice().sort((a, b) => a.v - b.v);
  return deckCanvas(6.7, 4.2, (g, W, H) => {
    g.font = font(9.5, true);
    const lw = Math.min(150, Math.max(...rows.map((r) => g.measureText(r.k).width)) + 10);
    const m = { l: lw, r: 34, t: 6, b: 22 },
      pw = W - m.l - m.r,
      ph = H - m.t - m.b;
    const max = Math.max(1, ...rows.map((r) => r.v)),
      step = niceStep(max * 1.1),
      top = Math.ceil((max * 1.1) / step) * step;
    const x = (v: number) => m.l + (v / top) * pw,
      rh = ph / Math.max(1, rows.length),
      bh = rh * 0.5;
    g.font = font(8.5);
    g.textAlign = "center";
    for (let v = 0; v <= top + 1e-9; v += step) {
      g.strokeStyle = DK.grid;
      g.lineWidth = 0.6;
      g.beginPath();
      g.moveTo(x(v), m.t);
      g.lineTo(x(v), m.t + ph);
      g.stroke();
      g.fillStyle = DK.axis;
      g.fillText(fmtInt(v), x(v), H - 10);
    }
    rows.forEach((r, i) => {
      const yc = m.t + rh * i + rh / 2;
      g.fillStyle = DK.light;
      g.fillRect(m.l, yc - bh / 2, x(r.v) - m.l, bh);
      g.fillStyle = DK.ink;
      g.font = font(9.5, true);
      g.textAlign = "right";
      g.fillText(r.k, m.l - 6, yc);
      g.textAlign = "left";
      g.fillText(fmtInt(r.v), x(r.v) + 4, yc);
    });
  });
}
function drawPie(parts: [string, number][]) {
  const colors = [DK.blue, DK.navy, DK.light, DK.amber];
  return deckCanvas(4.9, 3.2, (g, W, H) => {
    const total = parts.reduce((a, p) => a + p[1], 0) || 1,
      cx = W / 2,
      cy = (H - 26) / 2 + 4,
      r = Math.min(W * 0.24, (H - 26) / 2 - 18);
    let a0 = -Math.PI / 2;
    parts.forEach(([n, v], i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      g.fillStyle = colors[i % 4];
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, r, a0, a1);
      g.closePath();
      g.fill();
      g.strokeStyle = "#FFFFFF";
      g.lineWidth = 1;
      g.stroke();
      const mid = (a0 + a1) / 2,
        ex = cx + Math.cos(mid) * (r + 14),
        ey = cy + Math.sin(mid) * (r + 12);
      g.strokeStyle = "#7F7F7F";
      g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(cx + Math.cos(mid) * r * 0.98, cy + Math.sin(mid) * r * 0.98);
      g.lineTo(ex, ey);
      g.stroke();
      g.fillStyle = DK.sub;
      g.font = font(9);
      g.textAlign = Math.cos(mid) >= 0 ? "left" : "right";
      g.fillText(`${n}, ${fmtInt(v)}`, ex + (Math.cos(mid) >= 0 ? 3 : -3), ey);
      a0 = a1;
    });
    legendRow(g, parts.map(([n], i) => [n, colors[i % 4]]), W / 2, H - 10);
  });
}
function drawDispositionTrend(days: string[], fp: number[], pend: number[], tp: number[], bp: number[]) {
  return deckCanvas(12.7, 2.6, (g, W, H) => {
    const m = { l: 34, r: 10, t: 24, b: 52 },
      pw = W - m.l - m.r,
      ph = H - m.t - m.b;
    g.fillStyle = DK.ink;
    g.font = font(11, true);
    g.textAlign = "center";
    g.fillText("Disposition Trend", W / 2, 10);
    const max = Math.max(1, ...tp, ...bp, ...fp, ...pend),
      step = niceStep(max * 1.12, 4),
      top = Math.ceil((max * 1.12) / step) * step;
    const y = (v: number) => m.t + ph - (v / top) * ph,
      slot = pw / Math.max(1, days.length),
      cx = (i: number) => m.l + slot * i + slot / 2;
    g.font = font(7.5);
    g.textAlign = "right";
    for (let v = 0; v <= top + 1e-9; v += step) {
      g.strokeStyle = DK.grid;
      g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(m.l, y(v));
      g.lineTo(W - m.r, y(v));
      g.stroke();
      g.fillStyle = DK.axis;
      g.fillText(fmtInt(v), m.l - 4, y(v));
    }
    const bw = Math.min(7, slot * 0.3);
    days.forEach((_, i) => {
      g.fillStyle = DK.light;
      g.fillRect(cx(i) - bw, y(fp[i]), bw, m.t + ph - y(fp[i]));
      g.fillStyle = DK.amber;
      g.fillRect(cx(i), y(pend[i]), bw, m.t + ph - y(pend[i]));
    });
    const line = (vals: number[], color: string) => {
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      vals.forEach((v, i) => (i ? g.lineTo(cx(i), y(v)) : g.moveTo(cx(i), y(v))));
      g.stroke();
      vals.forEach((v, i) => {
        g.fillStyle = color;
        g.beginPath();
        g.arc(cx(i), y(v), 2.2, 0, 7);
        g.fill();
        g.fillStyle = DK.sub;
        g.font = font(6.5);
        g.textAlign = "center";
        g.fillText(fmtInt(v), cx(i), y(v) - 6);
      });
    };
    line(bp, DK.navy);
    line(tp, DK.blue);
    g.font = font(7);
    g.fillStyle = DK.axis;
    days.forEach((d, i) => {
      g.save();
      g.translate(cx(i), m.t + ph + 6);
      g.rotate(-Math.PI / 4);
      g.textAlign = "right";
      g.fillText(d, 0, 0);
      g.restore();
    });
    legendRow(g, [["False Positive", DK.light], ["Pending", DK.amber], ["True Positive", DK.blue, true], ["Benign Positive", DK.navy, true]], W / 2, H - 7);
  });
}
function scale3(p: number) {
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const Gc = [99, 190, 123],
    Y = [255, 235, 132],
    R = [248, 105, 107];
  const [a, b, t] = p < 0.5 ? [Gc, Y, p * 2] : [Y, R, (p - 0.5) * 2];
  return [0, 1, 2].map((i) => lerp(a[i], b[i], t as number).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export interface DeckText {
  slaTakeaway?: string;
  slaNext?: string;
  sevTakeaway?: string;
  sevNext?: string;
  catTakeaway?: string;
}

export function defaultDeckText(r: ReportInput): Required<DeckText> {
  const A = r.A,
    P = r.P;
  const bad: string[] = [];
  for (const p of PRIORITIES) for (const m of ["TTA", "TTI", "TTC", "TTR"] as const) if (A.sla[p][m].status === "bad") bad.push(`${p} ${m}`);
  const d = P && P.total ? A.total - P.total : null;
  const newB = P && P.total ? Object.keys(A.bucket).filter((k) => !(P.bucket[k] > 0)) : [];
  return {
    slaTakeaway: bad.length ? `SLA targets were missed for ${bad.join(", ")}; all other targets were met.` : "All SLA compliance targets were met for evaluable cases.",
    slaNext: bad.length ? `Review the breaching cases for ${bad.slice(0, 2).join(" and ")} and adjust triage priorities or staffing.` : "Keep monitoring SLA performance and fine-tune new detections to control alert volume.",
    sevTakeaway: d == null ? `${fmtInt(A.total)} cases were generated this period.` : `Case volume ${d >= 0 ? "rose" : "fell"} by ${fmtInt(Math.abs(d))}${newB.length ? `, driven by new detection sources (${newB.join(", ")})` : ""}.`,
    sevNext: "Continue rule tuning and filtering to reduce noise while maintaining detection coverage.",
    catTakeaway: "",
  };
}

export async function buildDeck(r: ReportInput, text: DeckText): Promise<Blob> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const A = r.A,
    P = r.P,
    P2 = r.P2;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "SOC-RAP";
  pptx.company = r.client;
  pptx.title = `Service Review – ${r.label}`;
  const F = "Tw Cen MT",
    src = r.source || "SOC",
    yr = r.period.start.slice(0, 4);
  const dt = defaultDeckText(r);
  const T = (k: keyof DeckText) => ((text[k] && text[k]!.trim()) || dt[k]).slice(0, 2000);
  let page = 0;
  type Slide = ReturnType<typeof pptx.addSlide>;
  const footer = (sl: Slide, note?: string) => {
    page++;
    if (note) sl.addText(note, { x: 3, y: 7.05, w: 6, h: 0.3, fontFace: F, fontSize: 8, color: "7F7F7F" });
    sl.addText(`${yr}     ${page}`, { x: 11.6, y: 7.05, w: 1.3, h: 0.3, fontFace: F, fontSize: 8, color: "7F7F7F", align: "right" });
  };
  const title = (sl: Slide, t: string) => sl.addText(t, { x: 0.5, y: 0.3, w: 12.3, h: 0.9, fontFace: F, fontSize: 36, bold: true, color: "000000", valign: "top", fit: "shrink" });
  const bullets = (arr: string[], size = 12, color = "000000") => arr.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < arr.length - 1, fontSize: size, color } }));
  let sl = pptx.addSlide();
  sl.background = { color: "0057B8" };
  sl.addText("Agenda", { x: 0.3, y: 3.1, w: 4, h: 0.9, fontFace: F, fontSize: 30, bold: true, color: "FFFFFF" });
  sl.addText(
    ["Program Summary", "Program Metrics", "Service Improvement", "Threat Hunting", "Rate | Scoping Elements"].map((t, i, a) => ({ text: t, options: { bullet: { type: "number" as const }, breakLine: i < a.length - 1 } })),
    { x: 5.1, y: 1.4, w: 6.5, h: 3.6, fontFace: F, fontSize: 20, color: "FFFFFF", paraSpaceAfter: 14, valign: "top" },
  );
  footer(sl);
  sl = pptx.addSlide();
  sl.background = { color: "000000" };
  sl.addText("Program Summary", { x: 0.5, y: 2.9, w: 11, h: 1, fontFace: F, fontSize: 36, bold: true, color: "FFFFFF" });
  footer(sl);
  sl = pptx.addSlide();
  sl.background = { color: "000000" };
  sl.addText("Threat Detection,\nResponse and\nProgram Metrics", { x: 0.5, y: 2.4, w: 11, h: 2.2, fontFace: F, fontSize: 36, bold: true, color: "FFFFFF", valign: "top" });
  footer(sl);
  // SLA summary
  sl = pptx.addSlide();
  title(sl, "Security Event SLA Summary");
  sl.addText(
    [
      { text: "Key Takeaway", options: { bold: true, color: "0057B8", fontSize: 18, breakLine: true } },
      { text: T("slaTakeaway"), options: { fontSize: 15, breakLine: true } },
      { text: " ", options: { fontSize: 6, breakLine: true } },
      { text: "Next Step", options: { bold: true, color: "0057B8", fontSize: 18, breakLine: true } },
      { text: T("slaNext"), options: { fontSize: 15 } },
    ],
    { x: 0.5, y: 1.25, w: 7.6, h: 2.05, fontFace: F, valign: "top", fit: "shrink" },
  );
  const fun: [number, string, string][] = [
    [A.total, `${src} Cases Generated`, "868B84"],
    [A.auto, "Automated Closure", "2B2B2B"],
    [A.tier12, "Tier 1 and 2 Investigations", "7EB6F0"],
    [A.tier3, "Tier 3 Investigations", "3D95F2"],
    [A.simulation, "Simulation Cases", "262626"],
  ];
  sl.addImage({ data: drawFunnel(fun), x: 8.95, y: 1.0, w: 4.3, h: 1.75, altText: "Case funnel" });
  sl.addNotes(fun.map(([v, l]) => `${l}: ${v}`).join("\n"));
  const hc = (t: string, o: Record<string, unknown> = {}) => ({ text: t, options: { bold: true, align: "center" as const, valign: "middle" as const, fontFace: F, ...o } });
  const rowsT: unknown[][] = [
    [hc(`Key Performance Indicators (${src} Cases)`, { colspan: 14, fill: { color: "002855" }, color: "FFFFFF", fontSize: 14, align: "left" })],
    [hc("", { fill: { color: "FFFFFF" } }), hc("Service Level Targets\nMonthly Average", { colspan: 6, fill: { color: "0057B8" }, color: "FFFFFF", fontSize: 12 }), hc("", { fill: { color: "FFFFFF" } }), hc("Actual", { colspan: 6, fill: { color: "0057B8" }, color: "FFFFFF", fontSize: 12 })],
    [
      hc("", { fill: { color: "FFFFFF" } }),
      ...["Time to\nAcknowledge", "Time to\nInvestigate", "Time to Contain"].map((t) => hc(t, { colspan: 2, fill: { color: "D9D9D9" }, fontSize: 9.5 })),
      hc("Cases", { fill: { color: "D9D9D9" }, fontSize: 9.5 }),
      ...["Average Time\nto Acknowledge", "Average Time to\nInvestigate", "Average Time\nto Contain"].map((t) => hc(t, { colspan: 2, fill: { color: "D9D9D9" }, fontSize: 9.5 })),
    ],
  ];
  const PRIO_FILL: Record<string, string> = { Critical: "6B1D1A", High: "D9472B", Medium: "FFB500", Low: "7A9A45" };
  for (const p of PRIORITIES) {
    const c = (t: string) => ({ text: t, options: { align: "center" as const, valign: "middle" as const, fontFace: F, fontSize: 10 } });
    const act = (m: "TTA" | "TTI" | "TTC") => {
      const x = A.sla[p][m];
      const good = x.status !== "bad";
      return [
        { text: fmtDur(x.mean), options: { align: "center" as const, valign: "middle" as const, fontFace: F, fontSize: 10, color: "4E7A1E" } },
        { text: x.pct == null ? "—" : fmtPct(x.pct), options: { align: "center" as const, valign: "middle" as const, fontFace: F, fontSize: 10, color: good ? "4E7A1E" : "C00000", bold: !good } },
      ];
    };
    rowsT.push([
      { text: p, options: { bold: true, color: "FFFFFF", fill: { color: PRIO_FILL[p] }, align: "center", valign: "middle", fontFace: F, fontSize: 10 } },
      c(fmtLimit(r.limits[p].TTA)),
      c(r.targets[p].TTA + "%"),
      c(fmtLimit(r.limits[p].TTI)),
      c(r.targets[p].TTI + "%"),
      c(fmtLimit(r.limits[p].TTC)),
      c(r.targets[p].TTC + "%"),
      { text: fmtInt(A.byPrio[p]), options: { bold: true, align: "center", valign: "middle", fontFace: F, fontSize: 10 } },
      ...act("TTA"),
      ...act("TTI"),
      ...act("TTC"),
    ]);
  }
  sl.addTable(rowsT as never, {
    x: 0.5,
    y: 3.35,
    w: 12.3,
    colW: [0.85, 0.95, 0.55, 0.95, 0.55, 0.95, 0.55, 0.7, 1.05, 0.8, 1.05, 0.8, 1.05, 0.8].map((x) => (x * 12.3) / 11.7),
    rowH: [0.36, 0.46, 0.46, 0.37, 0.37, 0.37, 0.37],
    border: { type: "solid", pt: 0.5, color: "D9D9D9" },
    fontFace: F,
  });
  footer(sl, "Note: Informational cases are not part of the SLA calculations");
  // Severity
  sl = pptx.addSlide();
  title(sl, `${src} Cases - Severity`);
  sl.addImage({ data: drawSeverity(A.byPrio), x: 0.4, y: 1.35, w: 6.7, h: 5.5, altText: "Cases by severity" });
  sl.addNotes("Cases by severity\n" + ALL_PRIORITIES.map((p) => `${p}: ${A.byPrio[p]}`).join("\n"));
  sl.addText([{ text: "Key Observations", options: { bold: true, color: "0057B8", fontSize: 12, breakLine: true } }, ...bullets(r.observations.slice(0, 6), 10.5)], { x: 7.35, y: 1.3, w: 5.6, h: 3.35, fontFace: F, valign: "top", fit: "shrink" });
  sl.addText(
    [
      { text: "Key Takeaway", options: { bold: true, color: "FFB500", fontSize: 12, breakLine: true } },
      { text: T("sevTakeaway"), options: { fontSize: 11, breakLine: true } },
      { text: " ", options: { fontSize: 6, breakLine: true } },
      { text: "Next Step", options: { bold: true, color: "FFB500", fontSize: 12, breakLine: true } },
      { text: T("sevNext"), options: { fontSize: 11 } },
    ],
    { x: 7.35, y: 4.8, w: 5.6, h: 2.1, fontFace: F, color: "FFFFFF", fill: { color: "0057B8" }, valign: "top", margin: 8, fit: "shrink" },
  );
  footer(sl);
  // Categories
  sl = pptx.addSlide();
  title(sl, `${src} Incident Total Tickets Created: Categories`);
  const bk = Object.keys(A.bucket).sort((a, b) => A.bucket[b] - A.bucket[a]);
  if (bk.length) sl.addImage({ data: drawCategories(bk.map((k) => ({ k, v: A.bucket[k] }))), x: 0.4, y: 1.3, w: 6.7, h: 4.2, altText: "Cases by category" });
  sl.addNotes("Cases by report bucket\n" + bk.map((k) => `${k}: ${A.bucket[k]}`).join("\n"));
  const catObs: string[] = [];
  const newB = P && P.total ? bk.filter((k) => !(P.bucket[k] > 0)) : [];
  if (newB.length) catObs.push(`${newB.join(" and ")} ${newB.length > 1 ? "were" : "was"} newly introduced this period (${newB.map((k) => fmtInt(A.bucket[k])).join(" and ")} cases).`);
  if (bk[0]) catObs.push(`${bk[0]} was the largest bucket with ${fmtInt(A.bucket[bk[0]])} cases (${((A.bucket[bk[0]] / A.total) * 100).toFixed(0)}%).`);
  if (A.auto) catObs.push(`Automation remained a major driver of case handling: ${fmtInt(A.auto)} cases were auto-closed.`);
  if (A.bucket.Other) catObs.push(`The “Other” bucket (${fmtInt(A.bucket.Other)}) mainly reflects overflow, simulation and smaller tools.`);
  if (A.uncategorized) catObs.push(`${fmtInt(A.uncategorized)} cases remain uncategorized.`);
  sl.addText([{ text: "Key Takeaway", options: { bold: true, color: "FFB500", fontSize: 12, breakLine: true } }, ...bullets((text.catTakeaway ? [text.catTakeaway] : []).concat(catObs), 11, "FFFFFF")], {
    x: 7.35,
    y: 1.3,
    w: 5.6,
    h: 4.1,
    fontFace: F,
    color: "FFFFFF",
    fill: { color: "0057B8" },
    valign: "top",
    margin: 8,
    fit: "shrink",
  });
  const allB = [...new Set([...bk, ...Object.keys(P?.bucket ?? {}), ...Object.keys(P2?.bucket ?? {})])];
  const th = (t: string) => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: "002855" }, align: "center" as const, fontFace: F, fontSize: 9 } });
  const tr = (lbl: string, o: Record<string, number>, col: string) => [
    { text: lbl, options: { bold: true, color: "0057B8", fontFace: F, fontSize: 9, align: "center" as const } },
    ...allB.map((k) => ({ text: fmtInt(o[k] || 0), options: { color: col, fontFace: F, fontSize: 9, align: "center" as const } })),
    { text: fmtInt(Object.values(o).reduce((a, b) => a + b, 0)), options: { bold: true, fontFace: F, fontSize: 9, align: "center" as const } },
  ];
  const bRows = [[th("Period"), ...allB.map(th), th("Total")], tr(r.short, A.bucket, "D9472B")];
  if (P && P.total) bRows.push(tr(r.prevShort, P.bucket, "000000"));
  if (P2 && P2.total) bRows.push(tr(r.p2Short, P2.bucket, "000000"));
  sl.addTable(bRows as never, { x: 0.5, y: 5.75, w: 12.3, rowH: 0.3, border: { type: "solid", pt: 0.5, color: "D9D9D9" } });
  footer(sl);
  // Disposition
  sl = pptx.addSlide();
  title(sl, `${src} Cases Daily Disposition Trend`);
  const cr = ["Maintenance", "Non-Malicious", "Malicious", "Pending"].filter((k) => A.closeR[k]);
  if (cr.length) sl.addImage({ data: drawPie(cr.map((k) => [k, A.closeR[k]])), x: 0.3, y: 1.2, w: 4.9, h: 3.2, altText: "Cases by close reason" });
  const dispObs = [
    `A total of ${fmtInt(A.total)} cases were identified, split between ${fmtInt(A.closeR["Non-Malicious"] || 0)} non-malicious and ${fmtInt(A.closeR.Malicious || 0)} malicious cases.`,
    `${fmtInt(A.closeR.Maintenance || 0)} cases were closed as maintenance.`,
    `${fmtInt(A.open)} cases remain open and are escalated or under active coordination.`,
  ];
  const peak = A.daily.map(([d, o]) => [d, Object.values(o).reduce((a, b) => a + b, 0)] as const).sort((a, b) => b[1] - a[1])[0];
  if (peak && peak[1]) dispObs.push(`The busiest ${peak[0].length === 10 ? "day" : "hour"} was ${peak[0].length === 10 ? fmtYmd(peak[0]) : peak[0]} with ${fmtInt(peak[1])} cases.`);
  sl.addText([{ text: "Key Observations", options: { bold: true, color: "FFB500", fontSize: 12, breakLine: true } }, ...bullets(dispObs, 11, "FFFFFF")], { x: 5.4, y: 1.2, w: 7.5, h: 3.1, fontFace: F, color: "FFFFFF", fill: { color: "0057B8" }, valign: "top", margin: 8, fit: "shrink" });
  const dk = A.daily.map((d) => d[0]);
  const dLbl = dk.map((k) => (k.length === 10 ? `${+k.slice(5, 7)}/${+k.slice(8)}/${k.slice(0, 4)}` : k));
  const dv = (n: string) => A.daily.map((d) => d[1][n] || 0);
  sl.addImage({ data: drawDispositionTrend(dLbl, dv("False Positive"), dv("Waiting Client"), dv("True Positive"), dv("Benign Positive")), x: 0.3, y: 4.4, w: 12.7, h: 2.6, altText: "Daily disposition trend" });
  sl.addNotes("Close reasons\n" + cr.map((k) => `${k}: ${A.closeR[k]}`).join("\n"));
  footer(sl);
  // MDR alert analysis
  sl = pptx.addSlide();
  title(sl, `MDR Alert Analysis – ${r.label}`);
  const ins = detectionInsights(A, tzAbbrev(r.displayTz), r.displayTz, r.cases.filter((c) => !c.excluded));
  sl.addText(`Alert Heat Map – alert volume by detection and hour (${tzAbbrev(r.displayTz)})`, { x: 0.5, y: 1.3, w: 8.4, h: 0.3, fontFace: F, fontSize: 13, bold: true });
  const top = Object.entries(A.heat)
    .map(([t, a]) => ({ t, a, n: a.reduce((x, y) => x + y, 0) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 10);
  const hmx = Math.max(1, ...top.flatMap((x) => x.a));
  const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
  const M = [0.01, 0.02, 0.01, 0.02];
  const hh = (t: string) => ({ text: t, options: { bold: true, fontSize: 5.5, fill: { color: "BDD7EE" }, align: "center" as const, fontFace: "Calibri", margin: M } });
  const heatRows: unknown[][] = [[{ text: "Row Labels", options: { bold: true, fontSize: 5.5, fill: { color: "BDD7EE" }, fontFace: "Calibri", margin: M } }, ...Array.from({ length: 24 }, (_, i) => hh(String(i))), hh("Grand Total")]];
  top.forEach((x) =>
    heatRows.push([
      { text: cut(x.t, 52), options: { fontSize: 5.5, fontFace: "Calibri", margin: M } },
      ...x.a.map((v) => ({ text: v ? String(v) : "", options: { fontSize: 5.5, align: "center", fontFace: "Calibri", margin: M, fill: v ? { color: scale3(v / hmx) } : undefined } })),
      { text: String(x.n), options: { fontSize: 5.5, align: "right", fontFace: "Calibri", margin: M } },
    ]),
  );
  if (top.length) sl.addTable(heatRows as never, { x: 0.5, y: 1.62, w: 8.4, colW: [2.6, ...Array(24).fill(0.215), 0.64], rowH: 0.155, border: { type: "solid", pt: 0.25, color: "FFFFFF" } });
  sl.addText("Disposition Heat Map – top detections by volume and outcome", { x: 0.5, y: 3.62, w: 8.4, h: 0.3, fontFace: F, fontSize: 13, bold: true });
  const dtop = ins.rows.slice(0, 12);
  const dRows: unknown[][] = [[{ text: "Row Labels", options: { bold: true, fontSize: 6, fill: { color: "BDD7EE" }, fontFace: "Calibri", margin: M } }, hh("Benign Positive"), hh("True Positive"), hh("False Positive"), hh("Grand Total")]];
  const dc = (t: string, o: Record<string, unknown> = {}) => ({ text: t, options: { fontSize: 6, align: "right" as const, fontFace: "Calibri", margin: M, ...o } });
  dtop.forEach((x) => dRows.push([dc(cut(x.t, 80), { align: "left" }), dc(x.bp.toFixed(2) + "%", { fill: { color: scale3(x.bp / 100) } }), dc(x.tp.toFixed(2) + "%", { fill: { color: scale3(1 - x.tp / 100) } }), dc(x.fp.toFixed(2) + "%", { fill: { color: scale3(x.fp / 100) } }), dc(String(x.n))]));
  if (dtop.length) sl.addTable(dRows as never, { x: 0.5, y: 3.95, w: 8.4, colW: [4.9, 0.9, 0.9, 0.9, 0.8], rowH: 0.19, border: { type: "solid", pt: 0.25, color: "FFFFFF" } });
  sl.addShape(pptx.ShapeType.line, { x: 9.15, y: 1.3, w: 0, h: 5.6, line: { color: "D9D9D9", width: 0.75 } });
  sl.addText([{ text: `Executive findings – what we saw in ${r.label}`, options: { bold: true, fontSize: 12, breakLine: true } }, ...bullets([`${r.label} generated ${fmtInt(A.total)} total alerts`, ...ins.findings], 8)], { x: 9.3, y: 1.3, w: 3.75, h: 2.7, fontFace: F, valign: "top", fit: "shrink" });
  const actRuns: { text: string; options: Record<string, unknown> }[] = [{ text: "MDR Findings and Next Actions", options: { bold: true, fontSize: 12, breakLine: true } }];
  const acts = ins.acts.slice(0, 5);
  acts.forEach(([a, t], i) => {
    actRuns.push({ text: a + ": ", options: { bold: true, color: "0057B8", fontSize: 8, bullet: true } });
    actRuns.push({ text: t, options: { fontSize: 8, breakLine: i < acts.length - 1 } });
  });
  sl.addText(actRuns as never, { x: 9.3, y: 4.05, w: 3.75, h: 2.95, fontFace: F, valign: "top", fit: "shrink" });
  footer(sl);
  return (await pptx.write({ outputType: "blob" })) as Blob;
}
