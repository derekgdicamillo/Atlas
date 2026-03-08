/**
 * Meeting Action Items Pipeline
 *
 * Pulls Otter.ai transcripts, extracts action items via Claude,
 * and sends summaries to Telegram. Tracks processed meetings
 * to avoid duplicates.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import {
  listSpeeches,
  getSpeech,
  searchSpeeches,
  formatDuration,
  transcriptToText,
  type OtterSpeech,
  type OtterSpeechDetail,
} from "./otter.ts";
import { runPrompt } from "./prompt-runner.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActionItem {
  task: string;
  owner: string;
  deadline: string;
  priority: "high" | "medium" | "low";
  context: string;
}

export interface MeetingSummary {
  otid: string;
  title: string;
  date: string;
  duration: string;
  attendees: string[];
  keyDecisions: string[];
  actionItems: ActionItem[];
  openQuestions: string[];
  summary: string;
}

interface ProcessedMeetings {
  processed: Record<string, { processedAt: string; title: string }>;
}

// ── State ────────────────────────────────────────────────────────────────────

const STATE_DIR = "data";
const STATE_FILE = `${STATE_DIR}/meetings-state.json`;
const OUTPUT_DIR = "data/meeting-notes";

async function loadState(): Promise<ProcessedMeetings> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { processed: {} };
  }
}

async function saveState(state: ProcessedMeetings): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Transcript Processing ────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a meeting analyst for PV MediSpa and Weight Loss, a medical weight loss clinic in Prescott Valley, AZ. The owners are Derek (FNP, clinical) and Esther (operations).

Analyze this meeting transcript and extract structured information.

Return ONLY valid JSON (no markdown fences, no commentary) in this exact format:
{
  "summary": "2-3 sentence executive summary of what was discussed and decided",
  "attendees": ["list", "of", "speaker", "names"],
  "keyDecisions": ["Decision 1", "Decision 2"],
  "actionItems": [
    {
      "task": "Specific actionable task description",
      "owner": "Person responsible (use speaker name, or 'Derek'/'Esther'/'Team' if unclear)",
      "deadline": "Mentioned deadline or 'This week'/'Next week'/'TBD'",
      "priority": "high|medium|low",
      "context": "Brief context from the discussion"
    }
  ],
  "openQuestions": ["Unresolved question 1", "Question needing follow-up"]
}

Rules:
- Action items must be SPECIFIC and ACTIONABLE (not vague like "follow up on things")
- If someone says "I'll do X" or "we need to do X", that's an action item
- Prioritize: anything with a deadline or revenue impact is high, process improvements are medium, nice-to-haves are low
- If no clear owner, assign to whoever suggested it or "Team"
- Include context so the action item makes sense without reading the full transcript
- If the meeting has no clear action items, return an empty array (don't invent them)
- Keep the summary concise and business-focused

TRANSCRIPT:
`;

export async function extractMeetingInsights(speech: OtterSpeechDetail): Promise<MeetingSummary> {
  const transcript = transcriptToText(speech);

  // Truncate very long transcripts to ~12k chars to fit in prompt
  const maxChars = 12000;
  const truncated = transcript.length > maxChars
    ? transcript.substring(0, maxChars) + "\n\n[... transcript truncated for length]"
    : transcript;

  const prompt = EXTRACTION_PROMPT + truncated;
  const result = await runPrompt(prompt, "claude-sonnet-4-6");

  let parsed: any;
  try {
    // Handle potential markdown fences
    let jsonStr = result.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    parsed = JSON.parse(jsonStr);
  } catch {
    // If parsing fails, return a basic summary
    return {
      otid: speech.otid,
      title: speech.title,
      date: new Date(speech.created_at * 1000).toISOString().split("T")[0],
      duration: formatDuration(speech.duration),
      attendees: [],
      keyDecisions: [],
      actionItems: [],
      openQuestions: [],
      summary: "Could not parse meeting insights. Raw transcript available.",
    };
  }

  return {
    otid: speech.otid,
    title: speech.title,
    date: new Date(speech.created_at * 1000).toISOString().split("T")[0],
    duration: formatDuration(speech.duration),
    attendees: parsed.attendees || [],
    keyDecisions: parsed.keyDecisions || [],
    actionItems: (parsed.actionItems || []).map((ai: any) => ({
      task: ai.task || "",
      owner: ai.owner || "Team",
      deadline: ai.deadline || "TBD",
      priority: ai.priority || "medium",
      context: ai.context || "",
    })),
    openQuestions: parsed.openQuestions || [],
    summary: parsed.summary || "",
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatMeetingSummaryTelegram(ms: MeetingSummary): string {
  const lines: string[] = [];

  lines.push(`**Meeting Notes: ${ms.title}**`);
  lines.push(`${ms.date} | ${ms.duration}${ms.attendees.length > 0 ? ` | ${ms.attendees.join(", ")}` : ""}`);
  lines.push("");
  lines.push(`**Summary:** ${ms.summary}`);

  if (ms.keyDecisions.length > 0) {
    lines.push("");
    lines.push("**Decisions:**");
    for (const d of ms.keyDecisions) {
      lines.push(`  • ${d}`);
    }
  }

  if (ms.actionItems.length > 0) {
    lines.push("");
    lines.push("**Action Items:**");
    for (const ai of ms.actionItems) {
      const priorityIcon = ai.priority === "high" ? "!!" : ai.priority === "medium" ? "!" : "";
      lines.push(`  ${priorityIcon ? priorityIcon + " " : ""}${ai.task}`);
      lines.push(`     Owner: ${ai.owner} | Due: ${ai.deadline}`);
    }
  }

  if (ms.openQuestions.length > 0) {
    lines.push("");
    lines.push("**Open Questions:**");
    for (const q of ms.openQuestions) {
      lines.push(`  ? ${q}`);
    }
  }

  return lines.join("\n");
}

// ── Commands ─────────────────────────────────────────────────────────────────

/** List recent meetings (for /meetings command) */
export async function listMeetings(limit = 10): Promise<string> {
  try {
    const speeches = await listSpeeches(limit);
    if (speeches.length === 0) return "No meetings found in Otter.ai.";

    const lines: string[] = ["**Recent Meetings**\n"];
    for (const s of speeches) {
      const date = new Date(s.created_at * 1000);
      const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      lines.push(`• **${s.title}** (${dateStr} ${timeStr}, ${formatDuration(s.duration)})`);
      lines.push(`  ID: \`${s.otid}\``);
      if (s.summary) {
        const short = s.summary.length > 100 ? s.summary.substring(0, 100) + "..." : s.summary;
        lines.push(`  ${short}`);
      }
      lines.push("");
    }

    lines.push("Use `/meetings <id>` to process a specific meeting.");
    return lines.join("\n");
  } catch (err) {
    return `Otter error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Process a specific meeting and extract action items */
export async function processMeeting(otid: string): Promise<MeetingSummary | string> {
  try {
    const speech = await getSpeech(otid);
    if (!speech.transcripts.length) {
      return `Meeting "${speech.title}" has no transcript content.`;
    }

    const summary = await extractMeetingInsights(speech);

    // Save to file
    if (!existsSync(OUTPUT_DIR)) await mkdir(OUTPUT_DIR, { recursive: true });
    const filename = `${OUTPUT_DIR}/${summary.date}-${speech.otid.substring(0, 8)}.json`;
    await writeFile(filename, JSON.stringify(summary, null, 2));

    // Mark as processed
    const state = await loadState();
    state.processed[otid] = { processedAt: new Date().toISOString(), title: speech.title };
    await saveState(state);

    return summary;
  } catch (err) {
    return `Error processing meeting: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Search meetings by keyword */
export async function searchMeetings(query: string, limit = 5): Promise<string> {
  try {
    const hits = await searchSpeeches(query, limit);
    if (hits.length === 0) return `No meetings found matching "${query}".`;

    const lines: string[] = [`**Search results for "${query}":**\n`];
    for (const h of hits) {
      const date = new Date(h.start_time * 1000);
      const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      lines.push(`• **${h.title}** (${dateStr}, ${formatDuration(h.duration)})`);
      lines.push(`  ID: \`${h.speech_otid}\``);
      if (h.speaker.length > 0) lines.push(`  Speakers: ${h.speaker.join(", ")}`);
      for (const mt of h.matched_transcripts.slice(0, 2)) {
        const snippet = mt.matched_transcript.length > 120
          ? mt.matched_transcript.substring(0, 120) + "..."
          : mt.matched_transcript;
        lines.push(`  [${mt.speaker_name}]: "${snippet}"`);
      }
      lines.push("");
    }

    return lines.join("\n");
  } catch (err) {
    return `Otter search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Cron: Check for new meetings ─────────────────────────────────────────────

/** Check for new unprocessed meetings and process them. Returns summaries sent. */
export async function checkNewMeetings(): Promise<MeetingSummary[]> {
  const state = await loadState();
  const speeches = await listSpeeches(10);

  // Filter to meetings from the last 24 hours that haven't been processed
  const cutoff = Date.now() / 1000 - 86400; // 24h ago
  const newMeetings = speeches.filter(
    (s) => s.created_at > cutoff && !state.processed[s.otid]
  );

  if (newMeetings.length === 0) return [];

  const summaries: MeetingSummary[] = [];
  for (const meeting of newMeetings) {
    const result = await processMeeting(meeting.otid);
    if (typeof result !== "string") {
      summaries.push(result);
    }
  }

  return summaries;
}
