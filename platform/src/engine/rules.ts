import type { Classification, Rule } from "./types";
import seed from "./seedRules.json";

export const SEED_RULESET_LABEL: string = seed.label;
export const seedRules = (): Rule[] => (seed.rules as Rule[]).map((r) => ({ ...r, sample_titles: [...(r.sample_titles ?? [])] }));

export const FALLBACK: Classification = { ruleId: "CAT-FALLBACK", category: "Uncategorized", sub: "", bucket: "Uncategorized", match: "" };

/**
 * Normalization applied to the match buffer only (spec §4.3.2). The stored title is never changed.
 * NFKC, strip invisible format characters, lowercase, every run of non-alphanumerics becomes one space, trim, 1,024 chars.
 * Underscores, hyphens and dots therefore act as word separators, so `account_lockouts` matches `account lockouts`.
 */
export function normTitle(s: unknown, keepCase = false): string {
  let t = String(s ?? "").normalize("NFKC").replace(/\p{Cf}/gu, "");
  if (!keepCase) t = t.toLowerCase();
  return t.replace(keepCase ? /[^A-Za-z0-9]+/g : /[^a-z0-9]+/g, " ").trim().slice(0, 1024);
}

/**
 * Safety gate for patterns (spec §8.4). Rejects constructs that can backtrack catastrophically,
 * lookarounds and backreferences, then checks the pattern compiles. Returns a plain-language error or null.
 */
export function checkPattern(p: unknown): string | null {
  if (typeof p !== "string" || !p.trim()) return "Enter a pattern.";
  if (p.length > 500) return "Keep patterns under 500 characters.";
  if (/\(\?<?[=!]/.test(p)) return "Lookarounds aren't allowed. Titles are normalized, so use \\b for word edges.";
  if (/\\[1-9]|\\k</.test(p)) return "Backreferences aren't allowed.";
  if (/\{\s*\d{4,}/.test(p)) return "Repeat counts above 999 aren't allowed.";
  // A repeated group ( … )+ ( … )* ( … ){n,} that itself contains a repeat or an alternative can backtrack exponentially.
  const src = p.replace(/\\./g, "_").replace(/\[[^\]]*\]/g, "_");
  const stack: { risky: boolean }[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") {
      stack.push({ risky: false });
      continue;
    }
    if (ch === ")") {
      const g = stack.pop() ?? { risky: false };
      const q = src[i + 1];
      if (g.risky && (q === "+" || q === "*" || q === "{"))
        return "Repeating a group that contains a repeat or | (for example (a|aa)+ or (a+)+) can hang the matcher. Simplify the pattern.";
      if (stack.length && (g.risky || q === "+" || q === "*" || q === "{")) stack[stack.length - 1].risky = true;
      continue;
    }
    if ((ch === "+" || ch === "*" || ch === "{" || ch === "|") && stack.length) stack[stack.length - 1].risky = true;
  }
  if (stack.length) return "The pattern has an unclosed bracket.";
  // Adjacent unbounded repeats over overlapping classes, e.g. \w+\w+ or .*.*, are quadratic or worse on long titles.
  if (/(\.\*|\.\+|\\w\+|\\w\*)\s*(\.\*|\.\+|\\w\+|\\w\*)/.test(p)) return "Two open-ended repeats in a row (like .*.*) are slow on long titles. Combine them.";
  try {
    new RegExp(p);
  } catch (e) {
    return "This isn't a valid pattern: " + (e as Error).message;
  }
  return null;
}

export interface CompiledRule extends Rule {
  rx: RegExp;
}

/** Enabled, valid rules in precedence order (ties by rule_id). Invalid or unsafe patterns are skipped and reported. */
export function compileRules(rules: Rule[]): { compiled: CompiledRule[]; rejected: { rule_id: string; error: string }[] } {
  const rejected: { rule_id: string; error: string }[] = [];
  const compiled = rules
    .filter((r) => r.enabled !== false)
    .filter((r) => {
      const e = checkPattern(r.pattern);
      if (e) rejected.push({ rule_id: r.rule_id, error: e });
      return !e;
    })
    .slice()
    .sort((a, b) => a.precedence - b.precedence || (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0))
    .map((r) => ({ ...r, rx: new RegExp(r.pattern) }));
  return { compiled, rejected };
}

interface Hit {
  r: CompiledRule;
  match: string;
}
function hitFor(r: CompiledRule, title: string, titleCased: string, desc: string, descCased: string): Hit | null {
  const fields = r.fields && r.fields.length ? r.fields : ["title"];
  for (const f of fields) {
    const buf = f === "title" ? (r.case_sensitive ? titleCased : title) : r.case_sensitive ? descCased : desc;
    if (!buf) continue;
    const m = r.rx.exec(buf);
    if (m) return { r, match: m[0].trim() };
  }
  return null;
}

/**
 * Ordered matching (spec §4.3.4). The lowest precedence that matches wins; within one precedence the longer
 * matched text wins, then the lower rule_id, and a tie between different categories is flagged as ambiguous.
 * With `audit`, every other matching rule is recorded.
 */
export function classify(
  title: string,
  compiled: CompiledRule[],
  opts: { description?: string; audit?: boolean } = {},
): Classification {
  const t = normTitle(title),
    tc = compiled.some((r) => r.case_sensitive) ? normTitle(title, true) : t;
  const d = opts.description ? normTitle(opts.description) : "",
    dc = opts.description && compiled.some((r) => r.case_sensitive) ? normTitle(opts.description, true) : d;
  let winner: Hit | null = null;
  let ambiguous = false;
  const also: string[] = [];
  for (let i = 0; i < compiled.length; ) {
    const prec = compiled[i].precedence;
    const group: Hit[] = [];
    for (; i < compiled.length && compiled[i].precedence === prec; i++) {
      const h = hitFor(compiled[i], t, tc, d, dc);
      if (h) group.push(h);
    }
    if (!group.length) continue;
    if (!winner) {
      group.sort((a, b) => b.match.length - a.match.length || (a.r.rule_id < b.r.rule_id ? -1 : 1));
      winner = group[0];
      ambiguous = group.length > 1 && group.some((g) => g.r.category !== winner!.r.category);
      also.push(...group.slice(1).map((g) => g.r.rule_id));
      if (!opts.audit) break;
    } else also.push(...group.map((g) => g.r.rule_id));
  }
  if (!winner) return { ...FALLBACK, alsoMatched: [] };
  return {
    ruleId: winner.r.rule_id,
    category: winner.r.category,
    sub: winner.r.subcategory ?? "",
    bucket: winner.r.report_bucket,
    match: winner.match,
    alsoMatched: also,
    ambiguous,
  };
}

/** Memoizing classifier: titles repeat heavily, so each distinct title is matched once per rule-set version. */
export function makeClassifier(rules: Rule[], audit = false) {
  const { compiled, rejected } = compileRules(rules);
  const cache = new Map<string, Classification>();
  return {
    compiled,
    rejected,
    classify(title: string, description = ""): Classification {
      const usesDesc = description && compiled.some((r) => r.fields?.includes("description"));
      const key = usesDesc ? title + "\u0000" + description : title;
      let c = cache.get(key);
      if (!c) {
        c = classify(title, compiled, { description: usesDesc ? description : "", audit });
        cache.set(key, c);
      }
      return c;
    },
  };
}

const STOP = new Set(["the", "a", "an", "of", "to", "for", "from", "on", "in", "by", "with", "and", "or", "is", "was", "ref", "vendor", "alert", "detected", "detection"]);
const escRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Suggested pattern for "Promote to rule" (spec §4.3.5): up to three consecutive words starting at the title's first
 * distinctive token, so the pattern always matches the title it came from.
 */
export function suggestPattern(norm: string): string {
  const toks = norm.split(" ").filter(Boolean);
  const distinctive = (t: string) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t);
  const start = toks.findIndex(distinctive);
  if (start < 0) return "";
  const run = toks.slice(start, start + 3);
  while (run.length > 1 && !distinctive(run[run.length - 1])) run.pop();
  return "\\b" + escRx(run.join(" ")) + "\\b";
}
export function exactTitlePattern(norm: string): string {
  return "^" + escRx(norm) + "$";
}

export interface RegressionFailure {
  rule_id: string;
  title: string;
  expected: string;
  got: string;
  gotRule: string;
}
/** Every rule's sample titles must still resolve to that rule's category (spec §4.3.6). */
export function regressionTest(rules: Rule[]): RegressionFailure[] {
  const { compiled } = compileRules(rules);
  const out: RegressionFailure[] = [];
  for (const r of rules) {
    if (r.enabled === false) continue;
    for (const t of r.sample_titles ?? []) {
      const c = classify(t, compiled);
      if (c.category !== r.category) out.push({ rule_id: r.rule_id, title: t, expected: r.category, got: c.category, gotRule: c.ruleId });
    }
  }
  return out;
}

export interface Movement {
  title: string;
  count: number;
  from: string;
  to: string;
  fromRule: string;
  toRule: string;
}
/** Category movements for a set of titles between two rule sets (the publish diff). */
export function categoryDiff(titles: Map<string, number>, before: Rule[], after: Rule[]): Movement[] {
  const a = makeClassifier(before),
    b = makeClassifier(after);
  const out: Movement[] = [];
  for (const [t, n] of titles) {
    const x = a.classify(t),
      y = b.classify(t);
    if (x.category !== y.category || x.bucket !== y.bucket) out.push({ title: t, count: n, from: x.category, to: y.category, fromRule: x.ruleId, toRule: y.ruleId });
  }
  return out.sort((p, q) => q.count - p.count);
}

/** Validates a rule set loaded from JSON import or the database. Returns clean rules and per-rule errors. */
export function sanitizeRules(input: unknown): { rules: Rule[]; errors: string[] } {
  const errors: string[] = [];
  const arr = Array.isArray(input) ? input : input && typeof input === "object" && Array.isArray((input as any).rules) ? (input as any).rules : null;
  if (!arr) return { rules: [], errors: ["The file doesn't contain a rules array."] };
  const seen = new Set<string>();
  const rules: Rule[] = [];
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const txt = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
  arr.slice(0, 1000).forEach((r: any, i: number) => {
    if (!r || typeof r !== "object") return void errors.push(`Item ${i + 1} isn't a rule.`);
    const rule_id = txt(r.rule_id, 60);
    if (!/^[A-Z0-9][A-Z0-9_-]{1,59}$/.test(rule_id)) return void errors.push(`Item ${i + 1}: rule_id must use A–Z, 0–9, - or _.`);
    if (seen.has(rule_id)) return void errors.push(`${rule_id}: duplicate rule_id.`);
    const e = checkPattern(r.pattern);
    if (e) return void errors.push(`${rule_id}: ${e}`);
    const category = txt(r.category, 100);
    if (!category) return void errors.push(`${rule_id}: category is required.`);
    const precedence = Number(r.precedence);
    if (!Number.isInteger(precedence) || precedence < 0 || precedence > 100000) return void errors.push(`${rule_id}: precedence must be a whole number.`);
    const fields = Array.isArray(r.fields) ? r.fields.filter((f: unknown) => f === "title" || f === "description") : ["title"];
    seen.add(rule_id);
    rules.push({
      rule_id,
      category,
      subcategory: txt(r.subcategory, 100),
      report_bucket: txt(r.report_bucket, 100) || "Other",
      pattern: String(r.pattern),
      precedence,
      fields: fields.length ? fields : ["title"],
      enabled: r.enabled !== false,
      case_sensitive: r.case_sensitive === true,
      notes: txt(r.notes, 1000),
      sample_titles: Array.isArray(r.sample_titles) ? r.sample_titles.slice(0, 50).map((s: unknown) => txt(s, 1000)).filter(Boolean) : [],
    });
  });
  return { rules, errors };
}
