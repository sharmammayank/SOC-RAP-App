import type { Limits, Metric, SlaPriority, Targets, Unit } from "./types";
import { UNIT_SECONDS } from "./types";

const cell = (value: number, unit: Unit) => ({ value, unit, seconds: Math.round(value * UNIT_SECONDS[unit]) });

/** Spec §4.2 seed values (SEP-2026-SLA-01). */
export const DEFAULT_LIMITS: Limits = {
  Critical: { TTA: cell(30, "min"), TTI: cell(1, "h"), TTC: cell(4, "h"), TTR: cell(16, "h") },
  High: { TTA: cell(1, "h"), TTI: cell(2, "h"), TTC: cell(8, "h"), TTR: cell(20, "h") },
  Medium: { TTA: cell(8, "h"), TTI: cell(4, "h"), TTC: cell(12, "h"), TTR: cell(24, "h") },
  Low: { TTA: cell(12, "h"), TTI: cell(8, "h"), TTC: cell(24, "h"), TTR: cell(72, "h") },
};

export const DEFAULT_TARGETS: Targets = {
  Critical: { TTA: 98, TTI: 98, TTC: 98, TTR: 98 },
  High: { TTA: 97, TTI: 97, TTC: 97, TTR: 95 },
  Medium: { TTA: 90, TTI: 90, TTC: 90, TTR: 90 },
  Low: { TTA: 90, TTI: 90, TTC: 90, TTR: 90 },
};

export const MAX_LIMIT_SECONDS = 30 * 86400;

export function makeCell(value: number, unit: Unit) {
  return cell(value, unit);
}

/** Validation per spec §4.2: positive integer seconds, at most 30 days. Returns an error or null. */
export function limitError(value: number, unit: Unit): string | null {
  if (!Number.isFinite(value) || value <= 0) return "Enter a positive number.";
  const s = value * UNIT_SECONDS[unit];
  if (Math.abs(s - Math.round(s)) > 1e-9) return "The limit must be a whole number of seconds.";
  if (s > MAX_LIMIT_SECONDS) return "The limit can't be longer than 30 days.";
  return null;
}

export function targetError(v: number): string | null {
  if (!Number.isFinite(v) || v < 0 || v > 100) return "Targets must be between 0 and 100.";
  if (Math.abs(v * 10 - Math.round(v * 10)) > 1e-9) return "Use at most one decimal place.";
  return null;
}

/** Advisory warnings (spec §4.2): TTA longer than TTI, or TTC longer than TTR, within a priority. */
export function limitWarnings(limits: Limits): string[] {
  const out: string[] = [];
  for (const p of Object.keys(limits) as SlaPriority[]) {
    const l = limits[p];
    if (l.TTA.seconds > l.TTI.seconds) out.push(`${p}: the TTA limit is longer than TTI`);
    if (l.TTC.seconds > l.TTR.seconds) out.push(`${p}: the TTC limit is longer than TTR`);
  }
  return out;
}

export function fmtLimit(c: { value: number; unit: Unit }): string {
  const n = Number(c.value);
  if (c.unit === "min") return `${n} ${n === 1 ? "Minute" : "Minutes"}`;
  if (c.unit === "h") return `${n} ${n === 1 ? "Hour" : "Hours"}`;
  return `${n} ${n === 1 ? "Second" : "Seconds"}`;
}

export const metricOrder: Metric[] = ["TTA", "TTI", "TTC", "TTR"];
