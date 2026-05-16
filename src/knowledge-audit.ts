/**
 * Atlas Prime — Knowledge Audit (Sprint 7)
 *
 * Weekly Saturday audit. For each fast/real_time domain in hot-domains.json,
 * pull recent Atlas answers, fetch authoritative source via WebFetch, score
 * drift, propose new half-life. Surface to Derek for approval.
 */
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { callHaiku } from "./haiku-client.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const HOT_DOMAINS_PATH = join(PROJECT_DIR, "data", "hot-domains.json");

const SAMPLE_SIZE = Number(process.env.KNOWLEDGE_AUDIT_SAMPLE_SIZE ?? 8);

// ============================================================
// MATH
// ============================================================

export function proposeHalfLife(currentHalfLifeDays: number, driftScore: number): number {
  if (driftScore <= 0) return currentHalfLifeDays;
  const D = Math.min(0.99, driftScore);
  const raw = -7 / Math.log2(1 - D);
  const ceiling = currentHalfLifeDays * 1.5;
  const clipped = Math.max(1, Math.min(ceiling, raw));
  return Math.ceil(clipped);
}

// ============================================================
// TYPES
// ============================================================

export interface AuditResult {
  domain: string;
  samples_examined: number;
  samples_still_correct: number;
  drift_score: number;
  current_half_life: number;
  proposed_half_life: number;
  rationale: string;
}

interface HotDomain {
  half_life_days: number;
  authoritative_sources: string[];
  llms_txt: string | null;
  changelog_url: string | null;
  last_refresh: string | null;
  tier: string;
  triggers: string[];
}

interface HotDomainsFile {
  version: number;
  updated_at: string;
  domains: Record<string, HotDomain>;
}

// ============================================================
// PER-DOMAIN AUDIT
// ============================================================

export interface AuditDeps {
  fetchRecentSamples: (domain: string, max: number) => Promise<string[]>;
  webFetch: (url: string, prompt: string) => Promise<string>;
}

export async function auditDomain(
  domain: string,
  spec: HotDomain,
  deps: AuditDeps,
  opts?: { sampleSize?: number }
): Promise<AuditResult> {
  const n = opts?.sampleSize ?? SAMPLE_SIZE;
  const samples = await deps.fetchRecentSamples(domain, n);
  if (samples.length === 0) {
    return {
      domain,
      samples_examined: 0,
      samples_still_correct: 0,
      drift_score: 0,
      current_half_life: spec.half_life_days,
      proposed_half_life: spec.half_life_days,
      rationale: "no recent samples to audit",
    };
  }
  const source = spec.authoritative_sources[0];
  if (!source) {
    return {
      domain,
      samples_examined: samples.length,
      samples_still_correct: samples.length,
      drift_score: 0,
      current_half_life: spec.half_life_days,
      proposed_half_life: spec.half_life_days,
      rationale: "no authoritative source configured; skipping audit",
    };
  }
  let sourceText: string;
  try {
    sourceText = await deps.webFetch(
      source,
      "Return the main content of this page. Focus on API changes, deprecations, feature additions."
    );
  } catch (err) {
    return {
      domain,
      samples_examined: samples.length,
      samples_still_correct: samples.length,
      drift_score: 0,
      current_half_life: spec.half_life_days,
      proposed_half_life: spec.half_life_days,
      rationale: `webFetch failed (${err}); kept current half-life`,
    };
  }

  let correct = 0;
  const verdicts: string[] = [];
  for (const claim of samples) {
    try {
      const { text } = await callHaiku({
        system:
          "Given current vendor documentation and an Atlas claim, decide if the claim is still correct. " +
          'Output strict JSON: {"correct": true|false, "reason": "<one sentence>"}.',
        userMessage: `### Current docs (excerpt)\n${sourceText.slice(0, 6000)}\n\n### Atlas claim\n${claim}`,
        maxTokens: 200,
        cacheSystem: true,
      });
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const v = JSON.parse(m[0]);
      if (v.correct === true) correct++;
      else if (v.reason) verdicts.push(String(v.reason));
    } catch {}
  }
  const drift = 1 - correct / samples.length;
  const proposed = proposeHalfLife(spec.half_life_days, drift);
  const rationale = verdicts.length
    ? `drift ${Math.round(drift * 100)}% — ${verdicts.slice(0, 2).join("; ")}`
    : `drift ${Math.round(drift * 100)}% (no specific failure reasons captured)`;
  return {
    domain,
    samples_examined: samples.length,
    samples_still_correct: correct,
    drift_score: drift,
    current_half_life: spec.half_life_days,
    proposed_half_life: proposed,
    rationale,
  };
}

// ============================================================
// FULL WEEKLY RUN
// ============================================================

export async function runWeeklyAudit(
  supabase: any,
  deps: AuditDeps
): Promise<AuditResult[]> {
  const raw = await readFile(HOT_DOMAINS_PATH, "utf-8");
  const file: HotDomainsFile = JSON.parse(raw);
  const results: AuditResult[] = [];
  for (const [domain, spec] of Object.entries(file.domains)) {
    if (spec.tier !== "fast" && spec.tier !== "real_time") continue;
    const r = await auditDomain(domain, spec, deps);
    results.push(r);
    if (supabase) {
      try {
        await supabase.from("knowledge_audit_log").insert({
          domain: r.domain,
          samples_examined: r.samples_examined,
          samples_still_correct: r.samples_still_correct,
          drift_score: r.drift_score,
          current_half_life: r.current_half_life,
          proposed_half_life: r.proposed_half_life,
          rationale: r.rationale,
          decision: "proposed",
        });
      } catch {}
    }
  }
  return results;
}

// ============================================================
// APPLY HALF-LIFE UPDATE
// ============================================================

export async function applyHalfLifeUpdate(opts: {
  domain: string;
  newHalfLife: number;
  decidedBy: string;
  supabase: any;
}): Promise<void> {
  const raw = await readFile(HOT_DOMAINS_PATH, "utf-8");
  const file: HotDomainsFile = JSON.parse(raw);
  if (!file.domains[opts.domain]) {
    throw new Error(`unknown domain: ${opts.domain}`);
  }
  file.domains[opts.domain].half_life_days = opts.newHalfLife;
  file.updated_at = new Date().toISOString();
  await writeFile(HOT_DOMAINS_PATH, JSON.stringify(file, null, 2) + "\n", "utf-8");

  const { appendEntry } = await import("./ledger.ts");
  await appendEntry({
    actor: "atlas",
    action: {
      tool: "hot_domains_update",
      args: { domain: opts.domain, new_half_life: opts.newHalfLife, decided_by: opts.decidedBy },
    },
    sourceClaims: [{ claim_id: `knowledge-audit:${opts.domain}` }],
    outcome: { success: true },
  });

  if (opts.supabase) {
    await opts.supabase
      .from("knowledge_audit_log")
      .update({
        decision: "applied",
        decided_by: opts.decidedBy,
        decided_at: new Date().toISOString(),
        override_value: opts.newHalfLife,
      })
      .eq("domain", opts.domain)
      .eq("decision", "proposed")
      .order("audit_at", { ascending: false })
      .limit(1);
  }
}

// ============================================================
// TELEGRAM SURFACE
// ============================================================

export function formatAuditSummary(results: AuditResult[]): string {
  const lines = [`📚 **Weekly Knowledge Audit — ${new Date().toISOString().slice(0, 10)}**`, ""];
  lines.push(`${results.length} domains examined.`, "");
  for (const r of results) {
    const emoji =
      r.proposed_half_life < r.current_half_life ? "🔻" :
      r.proposed_half_life > r.current_half_life ? "🔺" : "✓";
    lines.push(`${emoji} **${r.domain}** — drift ${Math.round(r.drift_score * 100)}% (${r.samples_still_correct}/${r.samples_examined} correct)`);
    lines.push(`  current: ${r.current_half_life}d · proposed: ${r.proposed_half_life}d`);
    lines.push(`  ${r.rationale.slice(0, 200)}`);
    lines.push("");
  }
  lines.push("Apply via `/audit apply <domain>` or `/audit applyall`.");
  return lines.join("\n");
}
