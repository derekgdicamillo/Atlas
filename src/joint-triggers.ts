/**
 * Atlas Prime — Joint Protocol I3 hard-coded triggers.
 * No Haiku classifier in the hot path; pure regex + light context gating.
 */
export interface I3Trigger {
  name: string;
  match: RegExp;
  contextKeywords?: string[];
  requiresAction?: boolean;
  alwaysFire?: boolean;
}

export const I3_TRIGGERS: I3Trigger[] = [
  {
    name: "hire-fire",
    match: /\b(hire|fire|terminate|let.{1,3}go|onboard.{0,4}staff)\b/i,
    contextKeywords: ["employee", "MD", "provider", "MA", "front desk", "staff", "medical director", "nurse"],
  },
  {
    name: "capex-over-5k",
    match: /\$\s?([5-9]|[1-9]\d+)[,.]?\d*\s?[kK]?\b/,
  },
  {
    name: "calendar-conflict",
    match: /\b(both .{0,12}calendar|joint .{0,8}calendar|family .{0,6}time|kids|sunday|weekend|date.{0,4}night)\b/i,
  },
  {
    name: "brand-tone-change",
    match: /\b(brand|voice|tone|messaging|positioning|tagline|rebrand)\b/i,
    requiresAction: true,
  },
  {
    name: "spec-tagged-joint",
    match: /joint:/,
    alwaysFire: true,
  },
];
