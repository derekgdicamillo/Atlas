/**
 * Atlas -- Workflow Template System
 *
 * Predefined multi-step task chains with dependency tracking.
 * Each workflow template defines a series of steps that execute
 * in order via the supervisor's dependsOn mechanism.
 *
 * Usage:
 *   [WORKFLOW: new-lead-enrich] -- instant execution
 *   [WORKFLOW: weekly-content | TRIGGER: monday 7am] -- scheduled
 */

import { registerTask } from "./supervisor.ts";
import { info, warn } from "./logger.ts";
import type { ModelTier } from "./constants.ts";

// ============================================================
// TYPES
// ============================================================

export interface WorkflowStep {
  /** Unique step ID within the workflow */
  id: string;
  /** Human-readable description */
  description: string;
  /** Prompt template with {{variable}} interpolation */
  promptTemplate: string;
  /** Model tier for this step */
  model: ModelTier;
  /** Step IDs this step depends on (within the workflow) */
  dependsOn: string[];
}

export interface WorkflowTemplate {
  name: string;
  description: string;
  steps: WorkflowStep[];
}

interface WorkflowInstance {
  workflowId: string;
  templateName: string;
  taskIds: Map<string, string>; // stepId -> supervisor taskId
  createdAt: string;
}

// ============================================================
// TEMPLATES
// ============================================================

const templates: Map<string, WorkflowTemplate> = new Map();

/**
 * new-lead-enrich: Research a new lead, then draft outreach.
 */
templates.set("new-lead-enrich", {
  name: "new-lead-enrich",
  description: "Research a lead and draft personalized outreach",
  steps: [
    {
      id: "research",
      description: "Research lead: {{lead_name}}",
      promptTemplate:
        "Research this person/company for a medical weight loss clinic outreach: {{lead_name}}. " +
        "Find their social media, any relevant health/wellness interests, professional background. " +
        "Output a 1-page brief with key talking points for personalized outreach.",
      model: "sonnet",
      dependsOn: [],
    },
    {
      id: "draft",
      description: "Draft outreach for: {{lead_name}}",
      promptTemplate:
        "Based on the research brief (read the output file from the previous task), " +
        "draft a personalized outreach message for {{lead_name}} from PV MediSpa & Weight Loss. " +
        "The message should be warm, professional, and reference specific details from the research. " +
        "Draft both an email version and a shorter text/DM version.",
      model: "sonnet",
      dependsOn: ["research"],
    },
  ],
});

/**
 * weekly-content: Research trends, outline, then draft.
 */
templates.set("weekly-content", {
  name: "weekly-content",
  description: "Research trends, create outline, then draft content piece",
  steps: [
    {
      id: "research",
      description: "Research trending topics in GLP-1/weight loss",
      promptTemplate:
        "Research the latest trending topics, news, and discussions in the GLP-1 and medical weight loss space. " +
        "Focus on: new studies, patient success patterns, common questions, and social media trends. " +
        "Output a 1-page trend report with 5 potential content angles.",
      model: "sonnet",
      dependsOn: [],
    },
    {
      id: "outline",
      description: "Create content outline from trends",
      promptTemplate:
        "Based on the trend research (read the output file from the previous task), " +
        "create a detailed content outline for the most promising angle. " +
        "Include: hook, main points, supporting data, CTA, and suggested formats (post, video, email). " +
        "Follow the voice guide in memory/voice-guide.md for Derek's teaching style.",
      model: "sonnet",
      dependsOn: ["research"],
    },
    {
      id: "draft",
      description: "Draft content piece from outline",
      promptTemplate:
        "Based on the outline (read the output file from the previous task), " +
        "draft a complete Skool community post. Follow Derek's voice (memory/voice-guide.md). " +
        "Make it educational, actionable, and engaging. Include a hook that stops the scroll.",
      model: "sonnet",
      dependsOn: ["outline"],
    },
  ],
});

/**
 * no-show-followup: Draft a re-engagement message for a patient who no-showed.
 */
templates.set("no-show-followup", {
  name: "no-show-followup",
  description: "Draft a warm re-engagement message for a no-show patient",
  steps: [
    {
      id: "draft",
      description: "Draft no-show follow-up for: {{lead_name}}",
      promptTemplate:
        "Draft a warm, non-judgmental follow-up message for {{lead_name}} who missed their appointment " +
        "at PV MediSpa & Weight Loss. The tone should be understanding (life happens), express genuine " +
        "concern for their weight loss goals, and make rescheduling easy. Include a brief reminder of " +
        "what they'll get at their consultation (body comp analysis, personalized plan review). " +
        "Draft both a text/SMS version (under 160 chars) and a longer email version. " +
        "Do NOT guilt-trip or use urgency tactics. Source: {{source}}",
      model: "haiku",
      dependsOn: [],
    },
  ],
});

/**
 * stale-lead-reactivate: Re-engage a lead that's been sitting idle in early pipeline stages.
 */
templates.set("stale-lead-reactivate", {
  name: "stale-lead-reactivate",
  description: "Draft a re-engagement message for a stale pipeline lead",
  steps: [
    {
      id: "draft",
      description: "Draft reactivation outreach for: {{lead_name}}",
      promptTemplate:
        "Draft a friendly re-engagement message for {{lead_name}} who expressed interest in " +
        "medical weight loss at PV MediSpa & Weight Loss but hasn't moved forward (lead has been " +
        "in the pipeline for {{days_stale}} days). The message should: " +
        "1) Acknowledge they may have been busy or had questions, " +
        "2) Share a relevant quick win or insight about GLP-1/medical weight loss, " +
        "3) Offer to answer any questions, " +
        "4) Make scheduling easy (mention the link or phone number). " +
        "Draft both a text version (under 300 chars) and an email version. " +
        "Tone: helpful, zero pressure, educational. Source: {{source}}",
      model: "haiku",
      dependsOn: [],
    },
  ],
});

/**
 * review-response: Analyze a review's sentiment, then draft a response.
 */
templates.set("review-response", {
  name: "review-response",
  description: "Analyze review sentiment and draft response",
  steps: [
    {
      id: "analyze",
      description: "Analyze review sentiment",
      promptTemplate:
        "Analyze this patient review for PV MediSpa & Weight Loss:\n\n{{review_text}}\n\n" +
        "Identify: overall sentiment, specific praise/complaints, emotional tone, " +
        "and any operational insights. Output a brief analysis.",
      model: "haiku",
      dependsOn: [],
    },
    {
      id: "respond",
      description: "Draft review response",
      promptTemplate:
        "Based on the sentiment analysis (read the output file from the previous task), " +
        "draft a professional, warm response to this review. " +
        "If positive: thank them genuinely, reference specifics. " +
        "If negative: acknowledge, empathize, offer to make it right. " +
        "Keep it under 150 words. Sign as 'The PV MediSpa Team'.",
      model: "sonnet",
      dependsOn: ["analyze"],
    },
  ],
});

// ============================================================
// INSTANTIATION
// ============================================================

// Active workflow instances (for tracking)
const activeWorkflows: Map<string, WorkflowInstance> = new Map();

/**
 * List available workflow templates.
 */
export function listWorkflows(): string {
  const lines = ["Available Workflows:\n"];
  for (const [name, template] of templates) {
    lines.push(`  ${name}: ${template.description} (${template.steps.length} steps)`);
  }
  return lines.join("\n");
}

/**
 * Instantiate a workflow from a template.
 * Creates tasks with proper dependsOn linkages via the supervisor.
 *
 * @param templateName Name of the workflow template
 * @param context Variables for prompt interpolation (e.g., { lead_name: "John" })
 * @returns Workflow ID and list of created task IDs
 */
export async function instantiateWorkflow(
  templateName: string,
  context: Record<string, string> = {},
): Promise<{ workflowId: string; taskIds: string[] } | null> {
  const template = templates.get(templateName);
  if (!template) {
    warn("workflows", `Unknown workflow template: ${templateName}`);
    return null;
  }

  const workflowId = `wf-${Date.now().toString(36)}`;
  const stepToTaskId = new Map<string, string>();
  const taskIds: string[] = [];

  for (const step of template.steps) {
    // Interpolate variables in the prompt template
    let prompt = step.promptTemplate;
    for (const [key, value] of Object.entries(context)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    // Map step dependsOn IDs to supervisor task IDs
    const depTaskIds = step.dependsOn
      .map(depStepId => stepToTaskId.get(depStepId))
      .filter(Boolean) as string[];

    const taskId = await registerTask({
      description: interpolate(step.description, context),
      prompt,
      model: step.model,
      requestedBy: "workflow",
      dependsOn: depTaskIds.length > 0 ? depTaskIds : undefined,
      workflowId,
    });

    stepToTaskId.set(step.id, taskId);
    taskIds.push(taskId);
  }

  // Track the workflow
  activeWorkflows.set(workflowId, {
    workflowId,
    templateName,
    taskIds: stepToTaskId,
    createdAt: new Date().toISOString(),
  });

  info("workflows", `Instantiated "${templateName}" as ${workflowId} with ${taskIds.length} tasks`);
  return { workflowId, taskIds };
}

/**
 * Get status of an active workflow.
 */
export function getWorkflowStatus(workflowId: string): string | null {
  const instance = activeWorkflows.get(workflowId);
  if (!instance) return null;

  const lines = [`Workflow: ${instance.templateName} (${workflowId})`];
  for (const [stepId, taskId] of instance.taskIds) {
    lines.push(`  ${stepId}: ${taskId}`);
  }
  return lines.join("\n");
}

// ============================================================
// HELPERS
// ============================================================

function interpolate(template: string, context: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(context)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}
