/**
 * Atlas — Evolution Pipeline (barrel export)
 */

export { runEvolutionPipeline, type PipelineResult } from "./pipeline.ts";
export { runScout, formatScoutReport, type ScoutReport, type ScoutFinding } from "./scout.ts";
export { runAudit, formatAuditSummary, formatAuditForArchitect, type ConversationAudit, type ConversationGrade } from "./audit.ts";
export { runArchitect, formatPlanForImplementer, type ArchitectPlan, type ArchitectChange } from "./architect.ts";
export { runValidator, type ValidationResult } from "./validator.ts";
export { runSummarizationV2, createWeeklySynthesis } from "./summarize-v2.ts";
export { runGraphEnrichment, type GraphEnrichmentResult } from "./graph-enrich.ts";
export {
  loadHistory,
  appendHistory,
  getRecentHistory,
  getRecurringIssues,
  getPendingFollowUps,
  buildHistoryContext,
  buildWeeklyScorecard,
  backfillErrorCount,
  type EvolutionRecord,
  type EvolutionPhaseResult,
  type EvolutionMetrics,
} from "./history.ts";
export { EVOLUTION_MAX_BUDGET_USD, EVOLUTION_PHASE_BUDGETS } from "./constants.ts";
