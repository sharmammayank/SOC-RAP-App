import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent, DatasetComponent, MarkLineComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { cssVar } from "@/lib/theme";

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, DatasetComponent, MarkLineComponent, CanvasRenderer]);

/** Re-renders when the colour scheme changes so charts follow light and dark themes. */
function useThemeKey() {
  const [k, setK] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setK((x) => x + 1);
    mq.addEventListener("change", on);
    const mo = new MutationObserver(on);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", on);
      mo.disconnect();
    };
  }, []);
  return k;
}

export const palette = () => ({
  s1: cssVar("--s1"),
  s2: cssVar("--s2"),
  s3: cssVar("--s3"),
  s4: cssVar("--s4"),
  s5: cssVar("--s5"),
  prev: cssVar("--prev"),
  ink: cssVar("--ink"),
  ink2: cssVar("--ink-2"),
  muted: cssVar("--muted"),
  grid: cssVar("--grid"),
  line: cssVar("--line"),
  surface: cssVar("--surface"),
});

export function EChart({ option, height = 260, ariaLabel }: { option: (p: ReturnType<typeof palette>) => EChartsCoreOption; height?: number; ariaLabel: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const themeKey = useThemeKey();
  useEffect(() => {
    if (!el.current) return;
    chart.current = echarts.init(el.current, undefined, { renderer: "canvas" });
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
    };
  }, []);
  useEffect(() => {
    const p = palette();
    chart.current?.setOption(
      {
        textStyle: { fontFamily: "IBM Plex Sans, system-ui, sans-serif", color: p.ink2 },
        tooltip: { backgroundColor: p.surface, borderColor: p.line, textStyle: { color: p.ink, fontSize: 12 } },
        ...option(p),
      },
      true,
    );
  }, [option, themeKey]);
  return <div ref={el} role="img" aria-label={ariaLabel} style={{ height, width: "100%" }} />;
}

export const axisStyle = (p: ReturnType<typeof palette>) => ({
  axisLine: { lineStyle: { color: p.line } },
  axisTick: { show: false },
  axisLabel: { color: p.muted, fontSize: 11 },
  splitLine: { lineStyle: { color: p.grid } },
});
