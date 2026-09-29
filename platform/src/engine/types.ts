/* Shared engine types. The engine is pure TypeScript: it runs in the browser, in a Web Worker and in Node tests. */

export const PRIORITIES = ["Critical", "High", "Medium", "Low"] as const;
export const ALL_PRIORITIES = ["Critical", "High", "Medium", "Low", "Informational"] as const;
export type SlaPriority = (typeof PRIORITIES)[number];
export type Priority = (typeof ALL_PRIORITIES)[number];

export const METRICS = [
  { k: "TTA", name: "Time to Acknowledge", short: "Acknowledge" },
  { k: "TTI", name: "Time to Investigate", short: "Investigate" },
  { k: "TTC", name: "Time to Contain", short: "Contain" },
  { k: "TTR", name: "Time to Remediate", short: "Remediate" },
] as const;
export type Metric = (typeof METRICS)[number]["k"];
export const METRIC_KEYS: Metric[] = METRICS.map((m) => m.k);

export type Unit = "s" | "min" | "h";
export const UNIT_SECONDS: Record<Unit, number> = { s: 1, min: 60, h: 3600 };
export const UNIT_LABEL: Record<Unit, string> = { s: "Seconds", min: "Minutes", h: "Hours" };

export interface LimitCell {
  value: number;
  unit: Unit;
  /** Normalized on save; always used for evaluation. */
  seconds: number;
}
export type Limits = Record<SlaPriority, Record<Metric, LimitCell>>;
export type Targets = Record<SlaPriority, Record<Metric, number>>;

export interface Rule {
  rule_id: string;
  category: string;
  subcategory?: string;
  report_bucket: string;
  pattern: string;
  precedence: number;
  fields?: ("title" | "description")[];
  enabled?: boolean;
  case_sensitive?: boolean;
  notes?: string;
  sample_titles?: string[];
}

export interface Classification {
  ruleId: string;
  category: string;
  sub: string;
  bucket: string;
  match: string;
  /** Rule IDs that also matched (audit mode). */
  alsoMatched?: string[];
  /** Two rules at the same precedence both matched. */
  ambiguous?: boolean;
}

export const TS_FIELDS = ["createdAt", "assignedAt", "investigatedTill", "containmentAt", "closedAt"] as const;
export type TsField = (typeof TS_FIELDS)[number];
export const METRIC_TS: Record<Metric, TsField> = {
  TTA: "assignedAt",
  TTI: "investigatedTill",
  TTC: "containmentAt",
  TTR: "closedAt",
};

/** One case as read from the upload, before review edits. Never mutated after build. */
export interface CaseRecord {
  rowNo: number;
  id: string;
  title: string;
  description: string;
  score: number | null;
  label: string | null;
  stage: string;
  disposition: string;
  closeReason: string;
  rootCause: string;
  assignee: string;
  isClosedFlag: boolean | null;
  supplied: Record<Metric, number | null>;
  /** Raw timestamp cell values, kept for display and audit. */
  raw: Record<TsField, unknown>;
  /** Parsed epoch ms; null = empty, NaN = unreadable. */
  ts: Record<TsField, number | null>;
}

export type MetricStatus = "MET" | "NOT_MET" | "PENDING" | "NA" | "ERROR";
export interface MetricResult {
  s: MetricStatus;
  el?: number | null;
  imputed?: boolean;
  why?: string;
}

/**
 * Review decisions, replayed over the raw cases. The latest edit per key wins.
 * They mirror rows in the `case_edits` table.
 */
export type Edit =
  | { kind: "priority"; rowNo: number; value: Priority }
  | { kind: "timestamp"; rowNo: number; field: TsField; value: number | null }
  | { kind: "void_metric"; rowNo: number; metric: Metric; reason: string }
  | { kind: "drop"; rowNo: number; reason: string }
  | { kind: "restore"; rowNo: number }
  | { kind: "category"; norm: string; category: string; bucket: string }
  | { kind: "accept"; key: string; reason?: string }
  | { kind: "period"; rowNo: number; include: boolean };

export interface EngineSettings {
  /** Count a missing acknowledge time as 0 s (MET). Matches the manual workbook. */
  ackZero: boolean;
  /** IANA zone that defines day, week and month boundaries. */
  periodTz: string;
  /** IANA zone for hour-of-day analytics and displayed times. */
  displayTz: string;
  /** Uncategorized rate (%) that raises a run-level warning. */
  uncategorizedWarnPct: number;
}

export const DEFAULT_SETTINGS: EngineSettings = {
  ackZero: true,
  periodTz: "UTC",
  displayTz: "Asia/Kolkata",
  uncategorizedWarnPct: 5,
};

export type IssueType = "PRIO" | "DUP" | "CHRONO" | "NEG" | "TS" | "PFIX" | "UNCAT" | "AMBIG" | "OUT" | "MISSING";
export interface Issue {
  key: string;
  type: IssueType;
  blocking: boolean;
  rows: number[];
  title?: string;
  norm?: string;
  field?: TsField;
  metric?: Metric;
  note?: string;
  caseId?: string;
}

export interface DerivedCase {
  rowNo: number;
  caseId: string;
  title: string;
  norm: string;
  category: string;
  subcategory: string;
  bucket: string;
  ruleId: string;
  match: string;
  priority: Priority | null;
  prioNote: string;
  ts: Record<TsField, number | null>;
  disposition: string;
  closeReason: string;
  rootCause: string;
  assignee: string;
  stage: string;
  isOpen: boolean;
  inPeriod: boolean;
  excluded: boolean;
  excludedReason: string;
  ev: Record<Metric, MetricResult>;
}
