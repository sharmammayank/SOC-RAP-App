import { supabase, must } from "./supabase";
import type { RulesetVersion } from "./db";
import type { Rule } from "@/engine/types";
import { latestRuleset } from "./runService";

/** The client's editable draft, created from the latest published version when none exists (spec §4.3.6). */
export async function getOrCreateDraft(clientId: string): Promise<RulesetVersion> {
  const d = must(await supabase.from("ruleset_versions").select("*").eq("client_id", clientId).eq("status", "draft").maybeSingle()) as RulesetVersion | null;
  if (d) return d;
  const base = await latestRuleset(clientId);
  return must(
    await supabase
      .from("ruleset_versions")
      .insert({ client_id: clientId, label: nextLabel(base.label), status: "draft", rules: base.rules, based_on: base.id, notes: "" })
      .select("*")
      .single(),
  ) as RulesetVersion;
}

export function nextLabel(label: string) {
  const m = /^(.*?)(\d+)$/.exec(label);
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${label}-2`;
}

export function nextUserRuleId(rules: Rule[]) {
  const n = rules.map((r) => /^CAT-USER-(\d+)$/.exec(r.rule_id)?.[1]).filter(Boolean).map(Number);
  return `CAT-USER-${String((n.length ? Math.max(...n) : 0) + 1).padStart(2, "0")}`;
}

/** "Promote to rule": appends to the next rule-set draft only; the committed run is not changed. */
export async function promoteToDraft(clientId: string, rule: Omit<Rule, "rule_id">): Promise<{ draft: RulesetVersion; rule: Rule }> {
  const draft = await getOrCreateDraft(clientId);
  const r: Rule = { ...rule, rule_id: nextUserRuleId(draft.rules) };
  const updated = must(await supabase.from("ruleset_versions").update({ rules: [...draft.rules, r] }).eq("id", draft.id).select("*").single()) as RulesetVersion;
  return { draft: updated, rule: r };
}
