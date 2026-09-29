import { Fragment, useMemo } from "react";
import { Download, Image as ImageIcon } from "lucide-react";
import type { HeatGrid } from "@/engine/analytics";
import { Button, Tip } from "./ui";
import { downloadBlob } from "@/lib/download";
import { toCsv } from "@/engine/xlsx/writer";

/**
 * Accessible heatmap grid (spec §6.1/§7.4): real table semantics with ARIA labels, numeric labels on demand,
 * sequential scale for counts and a diverging scale for breach % anchored at the target.
 */
export function Heatmap({
  g,
  showNumbers,
  onCell,
  compare,
  target,
  title,
  fileStem,
  rowLabel = "",
  colLabel = (c: string) => c,
}: {
  g: HeatGrid;
  showNumbers: boolean;
  onCell?: (r: number, c: number) => void;
  compare?: HeatGrid | null;
  /** For breach %: the breach level treated as neutral (100 − compliance target). */
  target?: number;
  title: string;
  fileStem: string;
  rowLabel?: string;
  colLabel?: (c: string) => string;
}) {
  const cmp = useMemo(() => {
    if (!compare) return null;
    const m = new Map<string, number>();
    compare.rows.forEach((r, i) => compare.cols.forEach((c, j) => m.set(r + "\u0000" + c, compare.cells[i][j])));
    return m;
  }, [compare]);
  const diverging = g.valueKind === "pct";
  const bg = (v: number) => {
    if (!diverging) {
      const p = g.max ? v / g.max : 0;
      return { background: `color-mix(in oklab, var(--heat-hi) ${Math.round(p * 100)}%, var(--heat-lo))`, color: p > 0.55 ? "var(--heat-flip)" : "var(--ink-2)" };
    }
    const mid = target ?? 5;
    if (v <= mid) {
      const p = mid ? v / mid : 0;
      return { background: `color-mix(in oklab, var(--surface-2) ${Math.round(p * 100)}%, var(--good-bg))`, color: "var(--ink-2)" };
    }
    const p = Math.min(1, (v - mid) / Math.max(1, 100 - mid) * 3);
    return { background: `color-mix(in oklab, var(--bad-ink) ${Math.round(p * 85)}%, var(--bad-bg))`, color: p > 0.5 ? "#fff" : "var(--ink-2)" };
  };
  const fmt = (v: number) => (diverging ? `${v.toFixed(1)}%` : v.toLocaleString("en-US"));

  const png = () => {
    const cw = g.cols.length > 12 ? 30 : 64,
      ch = 22,
      lw = 240,
      hh = 28;
    const c = document.createElement("canvas"),
      s = 2;
    c.width = (lw + cw * g.cols.length + 60) * s;
    c.height = (hh + ch * g.rows.length + 36) * s;
    const x = c.getContext("2d")!;
    x.scale(s, s);
    x.fillStyle = "#fff";
    x.fillRect(0, 0, c.width, c.height);
    x.font = "600 13px IBM Plex Sans, Arial";
    x.fillStyle = "#0E1726";
    x.fillText(title, 8, 18);
    x.font = "11px IBM Plex Sans, Arial";
    x.textBaseline = "middle";
    const hi = [13, 74, 150],
      lo = [234, 242, 252];
    g.cols.forEach((col, j) => {
      x.fillStyle = "#435066";
      x.textAlign = "center";
      x.fillText(colLabel(col).slice(0, 10), lw + cw * j + cw / 2, 28 + hh / 2);
    });
    g.rows.forEach((r, i) => {
      const y = 28 + hh + ch * i;
      x.fillStyle = "#0E1726";
      x.textAlign = "right";
      x.fillText(r.length > 38 ? r.slice(0, 37) + "…" : r, lw - 6, y + ch / 2);
      g.cols.forEach((_, j) => {
        const v = g.cells[i][j],
          p = g.max ? v / g.max : 0;
        x.fillStyle = diverging ? (v > (target ?? 5) ? `rgba(180,44,44,${Math.min(1, 0.2 + p)})` : "#E5F3E5") : `rgb(${lo.map((l, k) => Math.round(l + (hi[k] - l) * p)).join(",")})`;
        x.fillRect(lw + cw * j + 0.5, y + 0.5, cw - 1, ch - 1);
        if (showNumbers && v) {
          x.fillStyle = !diverging && p > 0.55 ? "#fff" : "#0E1726";
          x.textAlign = "center";
          x.fillText(fmt(v), lw + cw * j + cw / 2, y + ch / 2);
        }
      });
      x.fillStyle = "#435066";
      x.textAlign = "left";
      x.fillText(g.rowTotals[i].toLocaleString("en-US"), lw + cw * g.cols.length + 6, y + ch / 2);
    });
    c.toBlob((b) => b && downloadBlob(b, fileStem + ".png"), "image/png");
  };
  const csv = () => {
    const rows: (string | number)[][] = [[rowLabel || "Row", ...g.cols.map(colLabel), "Total"], ...g.rows.map((r, i) => [r, ...g.cells[i], g.rowTotals[i]])];
    downloadBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), fileStem + ".csv");
  };

  if (!g.rows.length) return <p className="text-[13px] text-muted">No cases in this window.</p>;
  return (
    <div>
      <div className="mb-2 flex justify-end gap-1">
        <Button size="sm" variant="ghost" icon={<ImageIcon className="size-3.5" />} onClick={png}>
          PNG
        </Button>
        <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={csv}>
          CSV
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-[2px] text-[11.5px]" aria-label={title}>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-[1] bg-surface px-2 text-left font-medium text-muted">
                {rowLabel}
              </th>
              {g.cols.map((c) => (
                <th key={c} scope="col" className="px-1 text-center font-medium whitespace-nowrap text-muted">
                  {colLabel(c)}
                </th>
              ))}
              <th scope="col" className="px-2 text-right font-medium text-muted">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {g.rows.map((r, i) => (
              <tr key={r}>
                <th scope="row" className="sticky left-0 z-[1] max-w-[280px] truncate bg-surface px-2 text-left font-normal text-ink" title={r}>
                  {r}
                </th>
                {g.cols.map((c, j) => {
                  const v = g.cells[i][j];
                  const prev = cmp?.get(r + "\u0000" + c);
                  const share = g.total ? ((diverging ? (g.denom?.[i][j] ?? 0) : v) / g.total) * 100 : 0;
                  const label = `${r}, ${colLabel(c)}: ${fmt(v)}${diverging ? ` (${g.denom?.[i][j] ?? 0} evaluable)` : ""}`;
                  return (
                    <Fragment key={c}>
                      <Tip
                        content={
                          <div>
                            <div className="font-semibold">{r}</div>
                            <div>{colLabel(c)}</div>
                            <div>
                              {fmt(v)}
                              {diverging ? ` breached · ${g.denom?.[i][j] ?? 0} evaluable` : ` cases · ${share.toFixed(1)}% of window`}
                            </div>
                            {cmp && <div>Comparison period: {prev == null ? "—" : fmt(prev)}</div>}
                            {onCell && <div className="opacity-70">Click for the cases</div>}
                          </div>
                        }
                      >
                        <td
                          tabIndex={onCell ? 0 : -1}
                          role={onCell ? "button" : undefined}
                          aria-label={label}
                          onClick={() => onCell?.(i, j)}
                          onKeyDown={(e) => {
                            if (onCell && (e.key === "Enter" || e.key === " ")) {
                              e.preventDefault();
                              onCell(i, j);
                            }
                          }}
                          className="num h-6 min-w-7 rounded-[3px] px-1 text-center outline-offset-1 focus-visible:outline-2"
                          style={{ ...bg(v), cursor: onCell ? "pointer" : "default" }}
                        >
                          {showNumbers && (v || diverging) ? fmt(v) : ""}
                        </td>
                      </Tip>
                    </Fragment>
                  );
                })}
                <td className="num px-2 text-right font-medium">{g.rowTotals[i].toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
