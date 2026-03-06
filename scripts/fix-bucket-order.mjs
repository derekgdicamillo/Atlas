// Two fixes:
// 1. Reverse bucket numbers so Planner mobile (which sorts reverse-alpha) shows correctly
// 2. Embed actual ad copy into task descriptions

import {
  listBuckets, listPlannerTasks, updateBucket, getTask, getTaskDetails, getAccessToken,
  listTeams, listPlansForGroup
} from '../src/m365.ts';
import { readFileSync } from 'fs';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function getFreshBucket(bucketId) {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}/planner/buckets/${bucketId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.json();
}

async function patchTaskDetails(taskId, description) {
  const token = await getAccessToken();
  // Get current details for etag
  const detRes = await fetch(`${GRAPH_BASE}/planner/tasks/${taskId}/details`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const details = await detRes.json();
  const etag = details['@odata.etag'] || '';
  if (!etag) throw new Error('No etag for task details');

  const patchRes = await fetch(`${GRAPH_BASE}/planner/tasks/${taskId}/details`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'If-Match': etag
    },
    body: JSON.stringify({ description })
  });
  if (!patchRes.ok) {
    const body = await patchRes.text();
    throw new Error(`PATCH failed ${patchRes.status}: ${body.substring(0, 200)}`);
  }
}

// Find plan
const teams = await listTeams();
let planId = null;
for (const team of teams) {
  try {
    const plans = await listPlansForGroup(team.id);
    const match = plans.find(p => p.title.toLowerCase().includes('ad creative'));
    if (match) { planId = match.id; break; }
  } catch {}
}
if (!planId) { console.log('No plan found'); process.exit(1); }

// --- Fix 1: Reverse bucket numbers ---
const buckets = await listBuckets(planId);
console.log('Current buckets:');
buckets.forEach(b => console.log(`  ${b.name}`));

// Current: 01=Copy Created ... 07=Tracking
// Need: 07=Copy Created ... 01=Tracking (so reverse-alpha puts 07 first = leftmost)
const renameMap = {
  '01 - copy created': '07 - Copy Created',
  '02 - concept ready for creative': '06 - Concept Ready for Creative',
  '03 - creative in progress': '05 - Creative In Progress',
  '04 - ready for ad creation': '04 - Ready for Ad Creation',
  '05 - ad in review': '03 - Ad In Review',
  '06 - ad accepted': '02 - Ad Accepted',
  '07 - tracking on website': '01 - Tracking on Website',
  // Also handle single-digit versions
  '1 - copy created': '07 - Copy Created',
  '2 - concept ready for creative': '06 - Concept Ready for Creative',
  '3 - creative in progress': '05 - Creative In Progress',
  '4 - ready for ad creation': '04 - Ready for Ad Creation',
  '5 - ad in review': '03 - Ad In Review',
  '6 - ad accepted': '02 - Ad Accepted',
  '7 - tracking on website': '01 - Tracking on Website',
};

console.log('\n--- Renaming buckets ---');
for (const bucket of buckets) {
  const key = bucket.name.toLowerCase();
  const newName = renameMap[key];
  if (!newName) { console.log(`  SKIP: "${bucket.name}"`); continue; }
  if (bucket.name === newName) { console.log(`  OK: "${bucket.name}"`); continue; }
  try {
    const fresh = await getFreshBucket(bucket.id);
    const etag = fresh['@odata.etag'] || '';
    if (etag) {
      await updateBucket(bucket.id, { name: newName }, etag);
      console.log(`  "${bucket.name}" -> "${newName}"`);
    }
    await new Promise(r => setTimeout(r, 500));
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
}

// --- Fix 2: Embed ad copy into task descriptions ---
console.log('\n--- Embedding ad copy into tasks ---');

// Parse the ad library to extract copy per concept
const library = readFileSync('ad-creative-library.md', 'utf8');

function extractConcept(conceptId) {
  // Find the section for this concept ID (e.g., LOCAL-01, TELE-05)
  const pattern = new RegExp(`### ${conceptId}:.*?(?=###|## Part|$)`, 'si');
  const match = library.match(pattern);
  if (!match) return null;

  let text = match[0];

  // Extract key parts
  const hookMatch = text.match(/\*\*Hook:\*\*\s*\n"([^"]+)"/);
  const hook = hookMatch ? hookMatch[1] : '';

  // Get the short copy
  const shortMatch = text.match(/\*\*Short \(3-4 lines\):\*\*\s*\n([\s\S]*?)(?=\n---|\n\*\*Medium)/);
  const shortCopy = shortMatch ? shortMatch[1].trim() : '';

  // Get visual direction
  const visualMatch = text.match(/\*\*Visual Direction:\*\*\s*([\s\S]*?)(?=\n---|\n\*\*CTA|\n$)/);
  const visual = visualMatch ? visualMatch[1].trim() : '';

  // Get CTA
  const ctaMatch = text.match(/\*\*CTA:\*\*\s*([\s\S]*?)(?=\n\*\*Visual|\n---|\n$)/);
  const cta = ctaMatch ? ctaMatch[1].trim() : '';

  // Get medium copy
  const medMatch = text.match(/\*\*Medium \(6-8 lines\):\*\*\s*\n([\s\S]*?)(?=\n---|\n\*\*Long)/);
  const medCopy = medMatch ? medMatch[1].trim() : '';

  return { hook, shortCopy, medCopy, visual, cta };
}

const tasks = await listPlannerTasks(planId);
let updated = 0;

for (const task of tasks) {
  // Extract concept ID from task title (e.g., "LOCAL-01:" or "TELE-05:")
  const idMatch = task.title.match(/(LOCAL-\d+|TELE-\d+)/i);
  if (!idMatch) {
    console.log(`  SKIP: "${task.title}" (no concept ID)`);
    continue;
  }

  const conceptId = idMatch[1].toUpperCase();
  const concept = extractConcept(conceptId);
  if (!concept) {
    console.log(`  SKIP: "${task.title}" (concept not found in library)`);
    continue;
  }

  // Build clean description with actual copy
  const description = [
    `HOOK: "${concept.hook}"`,
    '',
    '--- SHORT COPY ---',
    concept.shortCopy,
    '',
    '--- MEDIUM COPY ---',
    concept.medCopy,
    '',
    `CTA: ${concept.cta}`,
    '',
    `VISUAL DIRECTION: ${concept.visual}`,
  ].join('\n');

  try {
    await patchTaskDetails(task.id, description);
    console.log(`  Updated: ${task.title} (${description.length} chars)`);
    updated++;
    await new Promise(r => setTimeout(r, 400));
  } catch (err) {
    console.log(`  FAILED: "${task.title}" -- ${err.message}`);
  }
}

console.log(`\nDone. Renamed buckets, updated ${updated} task descriptions.`);
