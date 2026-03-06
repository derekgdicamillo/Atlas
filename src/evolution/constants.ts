/**
 * Atlas — Evolution Pipeline Constants
 */

// Total budget cap for the entire evolution pipeline per night
export const EVOLUTION_MAX_BUDGET_USD = 8.00;

// Per-phase budget allocations
export const EVOLUTION_PHASE_BUDGETS = {
  summarization: 0.30,  // haiku, topic clustering
  scout: 0.50,          // haiku, intelligence synthesis
  audit: 1.00,          // sonnet, conversation grading
  architect: 1.50,      // sonnet, implementation design
  implementer: 5.00,    // opus, code agent
  validator: 0.50,      // haiku, build check + verification
} as const;

// History settings
export const EVOLUTION_HISTORY_MAX_ENTRIES = 90; // ~3 months
export const EVOLUTION_RECURRING_ISSUE_THRESHOLD = 3; // appearances to flag as recurring

// Summarization v2 settings
export const TOPIC_CLUSTER_MIN_SIZE = 3;
export const TOPIC_CLUSTER_MAX_CLUSTERS = 15;
export const MAX_MESSAGES_PER_SUMMARIZATION = 500;
