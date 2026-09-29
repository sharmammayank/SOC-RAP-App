/* Row shapes for the Supabase tables (see supabase/migrations). Regenerate full types with `npm run db:types` if preferred. */
import type { Limits, Rule, Targets } from "@/engine/types";
import type { ColumnMap } from "@/engine/mapping";

export type ClientRole = "owner" | "reviewer" | "viewer";
export type RunStatus = "draft" | "staged" | "review" | "published" | "superseded";

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  is_admin: boolean;
  created_at: string;
}
export interface ClientSettings {
  ackZero?: boolean;
  uncategorizedWarnPct?: number;
  materiality?: { minAbs: number; minPct: number; concentrationPct: number };
  retentionMonths?: number;
}
export interface Client {
  id: string;
  name: string;
  period_tz: string;
  display_tz: string;
  default_cadence: "weekly" | "monthly" | "custom";
  source_label: string;
  settings: ClientSettings;
  created_at: string;
  archived_at: string | null;
}
export interface Member {
  client_id: string;
  user_id: string;
  role: ClientRole;
  added_at: string;
}
export interface ThresholdVersion {
  id: string;
  client_id: string;
  version_no: number;
  label: string;
  effective_from: string;
  limits: Limits;
  targets: Targets;
  notes: string;
  published_by: string | null;
  created_at: string;
}
export interface RulesetVersion {
  id: string;
  client_id: string | null;
  version_no: number | null;
  label: string;
  status: "draft" | "published";
  rules: Rule[];
  notes: string;
  effective_from: string | null;
  publish_check: unknown;
  based_on: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  published_by: string | null;
  published_at: string | null;
}
export interface RunSummary {
  rows?: number;
  inPeriod?: number;
  outOfPeriod?: number;
  included?: number;
  evaluable?: number;
  informational?: number;
  uncategorized?: number;
  uncategorizedPct?: number;
  blockingOpen?: number;
  nonBlockingOpen?: number;
  total?: number;
  /** Case-weighted compliance per metric (all priorities). */
  overall?: Record<string, number | null>;
  breaches?: number;
  attained?: number;
  targetsTotal?: number;
  engineVersion?: string;
}
export interface Run {
  id: string;
  client_id: string;
  cadence: "weekly" | "monthly" | "custom";
  period_start: string;
  period_end: string;
  status: RunStatus;
  threshold_version_id: string | null;
  ruleset_version_id: string | null;
  source_file_name: string | null;
  source_file_path: string | null;
  source_file_hash: string | null;
  source_file_size: number | null;
  source_sheet: string | null;
  row_count: number;
  column_map: ColumnMap | null;
  settings: { periodTz?: string; displayTz?: string; ackZero?: boolean; engineVersion?: string; headerRow?: number };
  summary: RunSummary;
  aggregate: unknown;
  observations: { text: string; kind: string; basis: unknown; include?: boolean }[] | null;
  report_text: Record<string, string>;
  supersedes_run_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  published_by: string | null;
  published_at: string | null;
}
export interface RunOverview {
  id: string;
  client_id: string;
  client_name: string;
  cadence: string;
  period_start: string;
  period_end: string;
  status: RunStatus;
  row_count: number;
  source_file_name: string | null;
  created_at: string;
  published_at: string | null;
  updated_at: string;
  summary: RunSummary;
  threshold_label: string | null;
  threshold_version_no: number | null;
  ruleset_label: string | null;
  ruleset_version_no: number | null;
  blocking_open: number;
  nonblocking_open: number;
}
export interface CaseDerivedRow {
  run_id: string;
  row_no: number;
  case_id: string;
  title: string;
  title_normalized: string;
  category: string;
  subcategory: string;
  report_bucket: string;
  matched_rule_id: string;
  matched_text: string;
  priority: string | null;
  prio_note: string;
  created_at: string | null;
  assigned_at: string | null;
  investigated_till: string | null;
  containment_at: string | null;
  closed_at: string | null;
  disposition: string;
  close_reason: string;
  root_cause: string;
  assignee: string;
  stage: string;
  is_open: boolean;
  in_period: boolean;
  excluded: boolean;
  excluded_reason: string;
  tta_sec: number | null;
  tti_sec: number | null;
  ttc_sec: number | null;
  ttr_sec: number | null;
  tta_status: string;
  tti_status: string;
  ttc_status: string;
  ttr_status: string;
  tta_note: string | null;
  tti_note: string | null;
  ttc_note: string | null;
  ttr_note: string | null;
  tta_imputed: boolean;
  dq_note: string;
}
export interface CaseEditRow {
  id: number;
  run_id: string;
  kind: string;
  row_no: number | null;
  case_id: string | null;
  target_key: string | null;
  field: string | null;
  old_value: unknown;
  new_value: unknown;
  reason: string;
  actor: string | null;
  created_at: string;
}
export interface ExceptionRow {
  run_id: string;
  key: string;
  type: string;
  severity: "blocking" | "non_blocking";
  status: "open" | "accepted" | "resolved";
  case_count: number;
  rows: number[];
  detail: Record<string, unknown>;
  updated_at: string;
}
export interface MetricSnapshot {
  run_id: string;
  priority: string;
  metric: string;
  met: number;
  not_met: number;
  pending: number;
  na: number;
  data_error: number;
  zero_imputed: number;
  compliance_pct: number | null;
  target_pct: number | null;
  variance_pts: number | null;
  status: "ok" | "bad" | "none";
  mean_sec: number | null;
  median_sec: number | null;
  p95_sec: number | null;
  worst: { caseId: string; title: string; el: number }[];
}
export interface Artifact {
  id: string;
  run_id: string;
  kind: string;
  file_path: string;
  file_name: string;
  size_bytes: number | null;
  created_by: string | null;
  created_at: string;
}
export interface AuditRow {
  id: number;
  client_id: string | null;
  actor: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}
