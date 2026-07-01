/**
 * Sprint 5 — Role Bootstrap. One-time Opus-driven generation of 32 candidate
 * roles. Outputs to data/roles/_pending/ for batch approval via /role approve.
 *
 * Usage: bun run src/role-bootstrap.ts
 * Cost: ~$0.50 (Opus, ~16K output tokens). Do NOT run in automated pipelines.
 *
 * DEVIATION FROM PLAN: plan imports `runOpus` from `./claude`, but `src/claude.ts`
 * only exports `callClaude` (a Claude Code CLI subprocess launcher — not suitable
 * for a standalone generator script). We instead use the @anthropic-ai/sdk directly,
 * the same pattern established in `src/derek-twin.ts`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import * as YAML from "js-yaml";
import { Anthropic } from "@anthropic-ai/sdk";
import { listRoles, listPending } from "./role-registry";

const PROMPT_TEMPLATE = `You are designing role cards for a multi-agent deliberation system serving a small medical aesthetics clinic (PV MediSpa).

Existing roles (do NOT duplicate):
{existing_role_summaries}

Source material to draw from:
=== business-intelligence.md ===
{bi_md}

=== voice-guide.md ===
{voice_guide_md}

=== behavioral-fixes.md ===
{behavioral_fixes_md}

Propose 32 NEW role cards. Cover these archetypes (1-2 each):
- Business mind frameworks: Buffett, Bezos, Walton, Cook, Dalio, Thiel, Blakely (7 roles)
- Persona voices: Customer-Voice, New-Patient-Persona, Long-Term-Patient-Persona, Confused-Vulnerable-Patient (4 roles)
- Functional specialists: Devil's Advocate, Operations-Realist, Tech-Debt-Watcher, Aesthetic-Practitioner, Weight-Loss-Expert, Nurse-Educator, Front-Desk-Realist (7 roles)
- Industry watchers: Med-Spa-Competitor-Analyst, Aesthetic-Trend-Watcher, GLP1-Market-Analyst, Regulatory-Watcher (4 roles)
- Cross-functional: Brand-Architect, Storyteller, Numbers-Translator, Crisis-Communicator, Decision-Documenter, Calendar-Optimist, Sleep-Guardian, Bible-Study-Defender, Family-Memory-Keeper, Ad-Compliance-Watcher (10 roles)

For each role output YAML with: id (kebab-case), name (Title Case), description (one sentence), prompt_fragment (3-6 line block scalar), domain_tags (array), mandatory_for (always empty for generated), created_at "2026-04-29", version 1.

Output a YAML array of exactly 32 cards. No commentary, no markdown fences, just YAML.`;

/**
 * Thin wrapper: call claude-opus-4-8 directly via the Anthropic SDK.
 * Returns the text content of the first message block.
 */
async function runOpus(prompt: string, opts: { maxTokens?: number } = {}): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: opts.maxTokens ?? 16000,
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content[0];
  if (!block || block.type !== "text") throw new Error("Unexpected response block type: " + (block as any)?.type);
  return block.text;
}

async function main() {
  const existing = await listRoles();
  const pending = await listPending();
  const existingSummary = [
    ...existing,
    ...pending.map((p) => ({ id: p.pending_id, name: p.role.name, description: p.role.description })),
  ]
    .map((r) => "- " + r.id + ": " + r.name + " — " + r.description)
    .join("\n");

  const bi = readFileSync(join(process.cwd(), ".claude/rules/business-intelligence.md"), "utf-8");
  const voice = readFileSync(join(process.cwd(), "memory/voice-guide.md"), "utf-8");
  const fixes = readFileSync(join(process.cwd(), ".claude/rules/behavioral-fixes.md"), "utf-8");

  const prompt = PROMPT_TEMPLATE
    .replace("{existing_role_summaries}", existingSummary || "(none)")
    .replace("{bi_md}", bi.slice(0, 8000))
    .replace("{voice_guide_md}", voice.slice(0, 4000))
    .replace("{behavioral_fixes_md}", fixes.slice(0, 4000));

  console.log("[role-bootstrap] calling Opus to generate 32 candidate roles...");
  const out = await runOpus(prompt, { maxTokens: 16000 });
  console.log("[role-bootstrap] received " + out.length + " chars");

  const cleaned = out.replace(/^```ya?ml\s*/i, "").replace(/```\s*$/i, "").trim();
  const candidates = YAML.load(cleaned) as Array<Record<string, unknown>>;
  if (!Array.isArray(candidates)) throw new Error("expected YAML array, got: " + typeof candidates);

  const pendDir = join(process.cwd(), "data/roles/_pending");
  mkdirSync(pendDir, { recursive: true });

  let written = 0;
  const seenIds = new Set<string>([
    ...existing.map((e) => e.id),
    ...pending.map((p) => p.pending_id),
  ]);

  for (const c of candidates) {
    const id = String(c.id ?? "");
    if (!id || seenIds.has(id)) {
      console.log("[role-bootstrap] skip duplicate/empty id: " + (id || "(empty)"));
      continue;
    }
    seenIds.add(id);
    const pendingId = randomBytes(4).toString("hex");
    writeFileSync(join(pendDir, pendingId + ".yaml"), YAML.dump(c));
    written += 1;
  }

  console.log("[role-bootstrap] wrote " + written + " pending role candidates to " + pendDir);
  console.log("[role-bootstrap] approve with: bun run scripts/approve-pending.ts <id>");
  console.log("[role-bootstrap] or via Telegram: /role approve <pending_id>");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("[role-bootstrap] fatal:", e);
    process.exit(1);
  });
}
