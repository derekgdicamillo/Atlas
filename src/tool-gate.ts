/**
 * Atlas Prime — Tool Gate
 *
 * Pre-dispatch enforcement of atlas.spec invariants.
 * Every externally-visible tool call passes through checkAction() first.
 * On deny, the action is blocked, a ledger entry is written with the
 * policy_decision, and the caller gets { allowed: false, reason }.
 */
import { readFileSync } from "fs";
import { join } from "path";
import * as YAML from "js-yaml";

// ============================================================
// TYPES
// ============================================================

type Op = "equals" | "matches" | "in" | "not_in" | "present" | "greater_than";

interface Predicate {
  path: string;
  op: Op;
  value?: unknown;
}

interface Invariant {
  name: string;
  applies_to: string;
  when?: Predicate;
  require?: Predicate[];
  forbid?: Predicate[];
}

interface AtlasSpec {
  version: number;
  invariants: Invariant[];
}

export interface Action {
  tool: string;
  args: Record<string, unknown>;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
  matchedInvariant?: string;
}

// ============================================================
// LOAD
// ============================================================

let cachedSpec: AtlasSpec | null = null;

export function loadSpec(specPath?: string): AtlasSpec {
  if (cachedSpec) return cachedSpec;
  const path = specPath || join(process.cwd(), "atlas.spec");
  const raw = readFileSync(path, "utf-8");
  cachedSpec = YAML.load(raw) as AtlasSpec;
  return cachedSpec;
}

export function resetSpecCache(): void {
  cachedSpec = null;
}

// ============================================================
// PREDICATE EVAL
// ============================================================

function getPath(obj: Record<string, unknown>, path: string): unknown {
  if (path === "_always") return true;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function evalPredicate(p: Predicate, args: Record<string, unknown>): boolean {
  const v = getPath(args, p.path);
  switch (p.op) {
    case "equals": return v === p.value;
    case "present": return v !== undefined && v !== null && v !== "";
    case "matches":
      if (typeof v !== "string" || typeof p.value !== "string") return false;
      return new RegExp(p.value).test(v);
    case "in":
      if (!Array.isArray(p.value)) return false;
      return p.value.includes(v as never);
    case "not_in":
      if (!Array.isArray(p.value)) return true;
      return !p.value.includes(v as never);
    case "greater_than":
      return typeof v === "number" && typeof p.value === "number" && v > p.value;
    default: return false;
  }
}

// ============================================================
// CHECK
// ============================================================

export function checkAction(action: Action, specPath?: string): GateResult {
  const spec = loadSpec(specPath);
  for (const inv of spec.invariants) {
    if (inv.applies_to !== action.tool) continue;
    if (inv.when && !evalPredicate(inv.when, action.args)) continue;

    if (inv.forbid) {
      for (const p of inv.forbid) {
        if (evalPredicate(p, action.args)) {
          return {
            allowed: false,
            reason: `${inv.name}: forbidden predicate matched (${p.path} ${p.op} ${JSON.stringify(p.value)})`,
            matchedInvariant: inv.name,
          };
        }
      }
    }

    if (inv.require) {
      for (const p of inv.require) {
        if (!evalPredicate(p, action.args)) {
          return {
            allowed: false,
            reason: `${inv.name}: required predicate failed (${p.path} ${p.op} ${JSON.stringify(p.value)})`,
            matchedInvariant: inv.name,
          };
        }
      }
    }
  }
  return { allowed: true };
}
