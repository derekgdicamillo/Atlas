/**
 * Restructure the Ad Creative Pipeline board to 7 buckets.
 *
 * Old: Concept Ready | Design In Progress | Review | Loaded to Meta
 * New: Copy Created | Concept Ready for Creative | Creative In Progress |
 *      Ready for Ad Creation | Ad In Review | Ad Accepted | Tracking on Website
 *
 * Steps:
 *  1. Find the Ad Creative Pipeline plan
 *  2. List existing buckets
 *  3. Rename existing buckets where possible
 *  4. Create missing buckets
 *  5. Reorder all 7 buckets left-to-right
 *  6. Move all existing tasks to "Copy Created"
 *
 * Run: bun run scripts/reorder-buckets.ts
 */

import {
  listTeams,
  listPlansForGroup,
  listBuckets,
  createBucket,
  updateBucket,
  deleteBucket,
  reorderBuckets,
  listPlannerTasks,
  updateTask,
  getTask,
} from "../src/m365.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TARGET_PLAN = "ad creative pipeline";

// Desired left-to-right order (7 buckets)
const DESIRED_ORDER = [
  "Copy Created",
  "Concept Ready for Creative",
  "Creative In Progress",
  "Ready for Ad Creation",
  "Ad In Review",
  "Ad Accepted",
  "Tracking on Website",
];

// Renames: old name (lowercase) -> new name
// These handle whatever state the board is in (original or partially renamed)
const RENAMES: Record<string, string> = {
  "concept ready": "Concept Ready for Creative",
  "design in progress": "Creative In Progress",
  "review": "Ad In Review",
  "ready for review": "Ad In Review",
  "loaded to meta": "Ad Accepted",
  "tracking": "Tracking on Website",
};

// Buckets that must exist after renames (create if missing)
const MUST_EXIST = ["Copy Created", "Ready for Ad Creation", "Ad In Review", "Tracking on Website"];

async function findPlan() {
  const teams = await listTeams();
  for (const team of teams) {
    try {
      const plans = await listPlansForGroup(team.id);
      const match = plans.find((p) => p.title.toLowerCase().includes(TARGET_PLAN));
      if (match) return match;
    } catch {
      // skip groups without planner access
    }
  }
  return null;
}

async function main() {
  console.log("=== Ad Creative Pipeline Board Restructure ===\n");

  // Step 1: Find the plan
  console.log("Step 1: Finding Ad Creative Pipeline plan...");
  const plan = await findPlan();
  if (!plan) {
    console.error("Ad Creative Pipeline plan not found!");
    process.exit(1);
  }
  console.log(`  Found: ${plan.title} (ID: ${plan.id})\n`);

  // Step 2: List current buckets
  console.log("Step 2: Listing current buckets...");
  let buckets = await listBuckets(plan.id);
  for (const b of buckets) {
    console.log(`  - ${b.name} (id: ${b.id}, etag: ${(b as any)["@odata.etag"] ? "yes" : "no"})`);
  }
  console.log();

  // Step 3: Rename buckets
  console.log("Step 3: Renaming buckets...");
  for (const bucket of buckets) {
    const newName = RENAMES[bucket.name.toLowerCase()];
    if (!newName) continue;

    console.log(`  Renaming "${bucket.name}" -> "${newName}"`);

    // Re-list to get fresh etag for this bucket
    const freshList = await listBuckets(plan.id);
    const fresh = freshList.find((b) => b.id === bucket.id);
    const etag = (fresh as any)?.["@odata.etag"] || "";
    if (!etag) {
      console.error(`  ERROR: No etag for "${bucket.name}". Skipping.`);
      continue;
    }
    await updateBucket(bucket.id, { name: newName }, etag);
    console.log(`  Done`);
    await delay(500);
  }
  console.log();

  // Step 3b: Remove duplicate buckets (keep first, delete empty duplicates)
  console.log("Step 3b: Removing duplicate buckets...");
  buckets = await listBuckets(plan.id);
  const tasks = await listPlannerTasks(plan.id);
  const seenNames = new Map<string, string>(); // lowercase name -> first bucket id
  for (const bucket of buckets) {
    const key = bucket.name.toLowerCase();
    if (seenNames.has(key)) {
      // Duplicate found. Check if this one has tasks.
      const tasksInBucket = tasks.filter((t) => t.bucketId === bucket.id);
      if (tasksInBucket.length === 0) {
        console.log(`  Deleting duplicate empty bucket: "${bucket.name}" (${bucket.id})`);
        const freshList = await listBuckets(plan.id);
        const fresh = freshList.find((b) => b.id === bucket.id);
        const etag = (fresh as any)?.["@odata.etag"] || "";
        if (etag) {
          try {
            await deleteBucket(bucket.id, etag);
            console.log(`  Deleted`);
          } catch (err) {
            console.error(`  Failed to delete: ${err}`);
          }
          await delay(500);
        }
      } else {
        console.log(`  Duplicate "${bucket.name}" has ${tasksInBucket.length} tasks, keeping it (moving tasks first)`);
        // Move tasks to the first bucket with this name
        const targetId = seenNames.get(key)!;
        for (const task of tasksInBucket) {
          const freshTask = await getTask(task.id);
          const taskEtag = (freshTask as any)["@odata.etag"] || "";
          if (taskEtag) {
            await updateTask(task.id, { bucketId: targetId }, taskEtag);
            await delay(500);
          }
        }
        // Now delete the empty duplicate
        const freshList2 = await listBuckets(plan.id);
        const fresh2 = freshList2.find((b) => b.id === bucket.id);
        const etag2 = (fresh2 as any)?.["@odata.etag"] || "";
        if (etag2) {
          try {
            await deleteBucket(bucket.id, etag2);
            console.log(`  Deleted after moving tasks`);
          } catch (err) {
            console.error(`  Failed to delete: ${err}`);
          }
          await delay(500);
        }
      }
    } else {
      seenNames.set(key, bucket.id);
    }
  }
  console.log();

  // Step 4: Create missing buckets
  console.log("Step 4: Creating missing buckets...");
  buckets = await listBuckets(plan.id);
  const existingNames = new Set(buckets.map((b) => b.name.toLowerCase()));

  for (const name of MUST_EXIST) {
    if (existingNames.has(name.toLowerCase())) {
      console.log(`  "${name}" already exists, skipping`);
      continue;
    }
    console.log(`  Creating "${name}"...`);
    const created = await createBucket(plan.id, name);
    console.log(`  Created (id: ${created.id})`);
    await delay(500);
  }
  console.log();

  // Step 5: Reorder all 7 buckets left-to-right
  console.log("Step 5: Reordering buckets...");
  console.log(`  Target: ${DESIRED_ORDER.join(" -> ")}`);
  await reorderBuckets(plan.id, DESIRED_ORDER);
  console.log("  Reorder complete");

  // Verify
  buckets = await listBuckets(plan.id);
  buckets.sort((a, b) => a.orderHint.localeCompare(b.orderHint));
  console.log("  Verified order:");
  for (let i = 0; i < buckets.length; i++) {
    console.log(`    ${i + 1}. ${buckets[i].name}`);
  }
  console.log();

  // Step 6: Move all tasks to Copy Created
  console.log("Step 6: Moving all tasks to Copy Created...");
  const copyCreatedBucket = buckets.find((b) => b.name.toLowerCase() === "copy created");
  if (!copyCreatedBucket) {
    console.error("  Copy Created bucket not found!");
    process.exit(1);
  }

  const tasks = await listPlannerTasks(plan.id);
  console.log(`  Found ${tasks.length} tasks total`);

  let moved = 0;
  let alreadyThere = 0;
  let failed = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    if (task.bucketId === copyCreatedBucket.id) {
      alreadyThere++;
      continue;
    }

    try {
      // Fetch fresh task for etag
      const fresh = await getTask(task.id);
      const etag = (fresh as any)["@odata.etag"] || "";
      if (!etag) {
        console.error(`  No etag for "${task.title}", skipping`);
        failed++;
        continue;
      }
      await updateTask(task.id, { bucketId: copyCreatedBucket.id }, etag);
      moved++;
      console.log(`  Moved: "${task.title}"`);
    } catch (err) {
      console.error(`  Failed: "${task.title}" - ${err}`);
      failed++;
    }

    // 500ms delay between API calls
    if (i < tasks.length - 1) await delay(500);
  }

  console.log();
  console.log("=== COMPLETE ===");
  console.log(`Plan: ${plan.title}`);
  console.log(`Buckets: ${DESIRED_ORDER.join(" | ")}`);
  console.log(`Tasks: ${moved} moved, ${alreadyThere} already in Copy Created, ${failed} failed`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
