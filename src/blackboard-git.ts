/**
 * Atlas Prime — Git-Branched Blackboard
 *
 * Substrate for Sprint 5 multi-agent deliberations. Bare repo at
 * data/atlas-blackboard.git, with worktrees per active deliberation.
 * Every commit gets a matching ledger entry (Sprint 1 Merkle ledger).
 *
 * DEVIATION FROM PLAN: The plan calls writeLedgerEntry(), but ledger.ts
 * exports appendEntry(LedgerInput). We call appendEntry() with a
 * properly-shaped LedgerInput and return entry.entryHash as ledgerEntryId.
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import { simpleGit, type SimpleGit } from "simple-git";
import { randomBytes } from "crypto";
import { appendEntry } from "./ledger";

// ============================================================
// TYPES
// ============================================================

export interface SignedContract {
  role_id: string;
  payload: unknown;
  signature: Buffer | string;
  timestamp: string;
}

export interface TranscriptCommit {
  hash: string;
  author: string;
  message: string;
  date: string;
  files: string[];
}

// ============================================================
// CONSTANTS
// ============================================================

const DEFAULT_ROOT = join(process.cwd(), "data");
const LOCK_TTL_MS = 5000;
const MAX_LOCK_RETRIES = 3;
const BRANCH_MAX_LEN = 60;

// ============================================================
// PATH HELPERS
// ============================================================

function bareRepoPath(root: string = DEFAULT_ROOT): string {
  return join(root, "atlas-blackboard.git");
}

function worktreesRoot(root: string = DEFAULT_ROOT): string {
  return join(root, "blackboard-worktrees");
}

function archiveRoot(root: string = DEFAULT_ROOT): string {
  return join(root, "blackboard-archive");
}

function lockPath(root: string = DEFAULT_ROOT): string {
  return join(root, "blackboard.lock");
}

// ============================================================
// LOCK (5s TTL, 3 retries, exponential backoff)
// ============================================================

async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lp = lockPath(root);
  let attempt = 0;
  while (attempt < MAX_LOCK_RETRIES) {
    try {
      if (!existsSync(lp)) {
        writeFileSync(lp, `${process.pid}:${Date.now()}`, { flag: "wx" });
        try {
          return await fn();
        } finally {
          try {
            rmSync(lp, { force: true });
          } catch {
            /* ignore cleanup error */
          }
        }
      }
      // Check for stale lock
      const content = readFileSync(lp, "utf-8");
      const ts = parseInt(content.split(":")[1] ?? "0", 10);
      if (Date.now() - ts > LOCK_TTL_MS) {
        rmSync(lp, { force: true });
        continue;
      }
    } catch {
      // race lost; back off
    }
    const backoff = 100 * Math.pow(4, attempt);
    await new Promise((r) => setTimeout(r, backoff));
    attempt += 1;
  }
  throw new Error(
    `BlackboardLockError: could not acquire ${lp} after ${MAX_LOCK_RETRIES} retries`
  );
}

// ============================================================
// GIT HELPERS
// ============================================================

function bareGit(root: string = DEFAULT_ROOT): SimpleGit {
  const repo = bareRepoPath(root);
  return simpleGit(repo);
}

function shortHash(): string {
  return randomBytes(2).toString("hex");
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build a branch name with format: <primitive>/<YYYY-MM-DD>-<slug>-<rand4>
 * Total length capped at BRANCH_MAX_LEN (60 chars).
 */
function buildBranchName(primitive: string, slug: string): string {
  const safeSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 30);
  const rand = shortHash();
  const candidate = `${primitive}/${todayISO()}-${safeSlug}-${rand}`;
  if (candidate.length > BRANCH_MAX_LEN) {
    const overhead = `${primitive}/${todayISO()}--${rand}`.length;
    const truncSlug = safeSlug.slice(0, Math.max(4, BRANCH_MAX_LEN - overhead));
    return `${primitive}/${todayISO()}-${truncSlug}-${rand}`;
  }
  return candidate;
}

/**
 * Convert a branch name to a filesystem-safe directory name.
 * Forward slashes → underscores. Truncated to 16-char hash suffix for Windows safety.
 */
function branchToDir(branch: string): string {
  // Use hash of full branch to ensure uniqueness on long names
  const safe = branch.replace(/[/\\]/g, "_");
  if (safe.length <= 80) return safe;
  // Truncate + append short hash for uniqueness
  const h = randomBytes(4).toString("hex");
  return safe.slice(0, 64) + "_" + h;
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Initialize the bare repo at <root>/atlas-blackboard.git.
 * Idempotent — safe to call multiple times.
 */
export async function initBlackboard(root: string = DEFAULT_ROOT): Promise<void> {
  const repo = bareRepoPath(root);
  if (existsSync(repo)) return;

  mkdirSync(dirname(repo), { recursive: true });
  mkdirSync(worktreesRoot(root), { recursive: true });
  mkdirSync(archiveRoot(root), { recursive: true });

  // Init bare repo
  const parentGit = simpleGit(dirname(repo));
  await parentGit.raw(["init", "--bare", "atlas-blackboard.git"]);

  // Seed an initial commit on 'main' so worktree creation has a base branch.
  const seedDir = join(worktreesRoot(root), "_bootstrap");
  mkdirSync(seedDir, { recursive: true });
  try {
    const seedG = simpleGit(seedDir);
    await seedG.init();
    await seedG.addConfig("user.email", "atlas@pvmedispa.com");
    await seedG.addConfig("user.name", "Atlas");
    writeFileSync(
      join(seedDir, "README.md"),
      "Atlas blackboard bare repo. Do not edit directly.\n"
    );
    await seedG.add("README.md");
    await seedG.commit("init: atlas blackboard");
    await seedG.addRemote("origin", repo);
    // Push as 'main' branch
    await seedG.push(["origin", "HEAD:main"]);
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
  }
}

/**
 * Open a new deliberation branch with a worktree.
 * Returns the branch name and the absolute path to the worktree.
 */
export async function openDeliberation(
  slug: string,
  primitive: "council" | "joint" | "marketplace" | "role-audit",
  parentBranch: string | undefined = undefined,
  root: string = DEFAULT_ROOT
): Promise<{ branch: string; worktreePath: string }> {
  await initBlackboard(root);

  const branch = buildBranchName(primitive, slug);
  // Windows path safety: convert slashes and keep length reasonable
  const dirName = branchToDir(branch);
  const worktreePath = join(worktreesRoot(root), dirName);

  await withLock(root, async () => {
    const git = bareGit(root);
    const base = parentBranch ?? "main";
    await git.raw(["worktree", "add", "-b", branch, worktreePath, base]);
  });

  // Initial open commit so the branch has at least one Sprint 5 commit.
  // Wrap in try/catch: if anything fails here the worktree was already created
  // (inside the lock above), so we must force-remove it before re-throwing.
  const wt = simpleGit(worktreePath);
  try {
    await wt.addConfig("user.email", "atlas@pvmedispa.com");
    await wt.addConfig("user.name", "Atlas");

    const meta = {
      primitive,
      slug,
      opened_at: new Date().toISOString(),
      parent_branch: parentBranch ?? null,
    };
    writeFileSync(join(worktreePath, "deliberation.json"), JSON.stringify(meta, null, 2));
    writeFileSync(join(worktreePath, "contracts.jsonl"), "");
    await wt.add(["deliberation.json", "contracts.jsonl"]);
    await wt.commit(`open: ${primitive} deliberation ${slug}`);

    // Push back to bare repo so bare has the branch ref
    await wt
      .push(["origin", `HEAD:${branch}`])
      .catch(async () => {
        // If origin isn't configured in the worktree, add it
        await wt.addRemote("origin", bareRepoPath(root));
        await wt.push(["origin", `HEAD:${branch}`]);
      });
  } catch (err) {
    // Clean up the dangling worktree so the bare repo stays consistent
    try {
      await bareGit(root).raw(["worktree", "remove", "--force", worktreePath]);
    } catch {
      // best-effort; ignore cleanup error
    }
    throw err;
  }

  return { branch, worktreePath };
}

/**
 * Append a signed contract to contracts.jsonl in the worktree,
 * commit it, and write a matching ledger entry.
 */
export async function commitContract(
  branch: string,
  contract: SignedContract,
  message: string,
  root: string = DEFAULT_ROOT
): Promise<{ commitHash: string; ledgerEntryId: string }> {
  const dirName = branchToDir(branch);
  const worktreePath = join(worktreesRoot(root), dirName);

  if (!existsSync(worktreePath)) {
    throw new Error(`worktree not found for branch ${branch} (expected at ${worktreePath})`);
  }

  const wt = simpleGit(worktreePath);

  const sigB64 = Buffer.isBuffer(contract.signature)
    ? contract.signature.toString("base64")
    : contract.signature;

  const line = JSON.stringify({ ...contract, signature: sigB64 }) + "\n";
  appendFileSync(join(worktreePath, "contracts.jsonl"), line);

  await wt.add("contracts.jsonl");
  try {
    await wt.commit(`${contract.role_id}: ${message}`, undefined, {
      "--author": `${contract.role_id} <${contract.role_id}@atlas.local>`,
    });
  } catch (commitErr) {
    // Rollback worktree to last good HEAD on commit failure
    await wt.raw(["reset", "--hard"]);
    throw commitErr;
  }

  await wt.push(["origin", `HEAD:${branch}`]);
  const head = (await wt.revparse(["HEAD"])).trim();
  const commitHash = head;

  // Chain to Sprint 1 Merkle ledger — must succeed or we throw LedgerSyncError
  let ledgerEntryId = "";
  try {
    const entry = await appendEntry({
      actor: "atlas",
      action: {
        tool: "blackboard.commitContract",
        args: {
          branch,
          commit: commitHash,
          role_id: contract.role_id,
          message,
        },
      },
      sourceClaims: [
        {
          claim_id: `blackboard:${commitHash}`,
          source_file: "src/blackboard-git.ts",
        },
      ],
      outcome: { success: true },
    });
    ledgerEntryId = entry.entryHash;
  } catch (e) {
    throw new Error(
      `LedgerSyncError: blackboard commit ${commitHash} could not be ledger-chained: ${(e as Error).message}`
    );
  }

  return { commitHash, ledgerEntryId };
}

/**
 * Fork a dissent branch from an existing deliberation branch.
 * Creates a new worktree branching from the parent.
 */
export async function forkDissent(
  branch: string,
  dissenterId: string,
  dissentSlug: string,
  root: string = DEFAULT_ROOT
): Promise<{ newBranch: string; worktreePath: string }> {
  const primitive = branch.split("/")[0] ?? "council";
  const newBranch = buildBranchName(
    `${primitive}-dissent-${dissenterId.slice(0, 16)}`,
    dissentSlug
  );
  const dirName = branchToDir(newBranch);
  const worktreePath = join(worktreesRoot(root), dirName);

  await withLock(root, async () => {
    const git = bareGit(root);
    await git.raw(["worktree", "add", "-b", newBranch, worktreePath, branch]);
  });

  return { newBranch, worktreePath };
}

/**
 * Close a deliberation by writing a final memo commit and a ledger entry.
 */
export async function mergeDeliberation(
  branch: string,
  mergeMemo: string,
  arbitratorId: string,
  agreed: boolean,
  root: string = DEFAULT_ROOT
): Promise<{ mergeCommit: string; ledgerEntryId: string }> {
  const dirName = branchToDir(branch);
  const worktreePath = join(worktreesRoot(root), dirName);

  if (!existsSync(worktreePath)) {
    throw new Error(`worktree not found for branch ${branch}`);
  }

  const wt = simpleGit(worktreePath);

  // Issue 2 fix: wrap commit chain in try/catch with hard reset on failure
  // so a mid-flight failure doesn't leave dirty state in the worktree.
  writeFileSync(
    join(worktreePath, "final-memo.md"),
    `# Final Memo\n\n**Arbitrator:** ${arbitratorId}\n**Agreed:** ${agreed}\n**Closed:** ${new Date().toISOString()}\n\n${mergeMemo}\n`
  );
  let head: string;
  try {
    await wt.add("final-memo.md");
    await wt.commit(`close: arbitrator ${arbitratorId} (agreed=${agreed})`);
    await wt.push(["origin", `HEAD:${branch}`]);
    head = (await wt.revparse(["HEAD"])).trim();
  } catch (commitErr) {
    // Rollback worktree to last good HEAD on commit/push failure
    await wt.reset(["--hard"]);
    throw commitErr;
  }

  // Issue 3 fix: label appendEntry failures as LedgerSyncError for consistency
  // with commitContract.
  try {
    const entry = await appendEntry({
      actor: "atlas",
      action: {
        tool: "blackboard.mergeDeliberation",
        args: {
          branch,
          commit: head,
          arbitrator_id: arbitratorId,
          agreed,
        },
      },
      sourceClaims: [
        {
          claim_id: `blackboard:merge:${head}`,
          source_file: "src/blackboard-git.ts",
        },
      ],
      outcome: { success: true },
    });
    return { mergeCommit: head, ledgerEntryId: entry.entryHash };
  } catch (e) {
    throw new Error(
      `LedgerSyncError: blackboard merge ${head} could not be ledger-chained: ${(e as Error).message}`
    );
  }
}

/**
 * Walk all commits on a branch from newest to oldest.
 */
export async function walkTranscript(
  branch: string,
  root: string = DEFAULT_ROOT
): Promise<TranscriptCommit[]> {
  const git = bareGit(root);
  // Use the branch ref directly for a single-branch log
  const log = await git.log({ [branch]: null } as Record<string, null>);
  return log.all.map((c) => ({
    hash: c.hash,
    author: c.author_name,
    message: c.message,
    date: c.date,
    files: [],
  }));
}

/**
 * List all open deliberations (branches matching the primitive/slug pattern).
 */
export async function listOpen(
  root: string = DEFAULT_ROOT
): Promise<{ branch: string; primitive: string; openedAt: string; ageH: number }[]> {
  await initBlackboard(root);
  const git = bareGit(root);
  const branchInfo = await git.branch(["--list", "*/*"]);
  const out: { branch: string; primitive: string; openedAt: string; ageH: number }[] = [];

  for (const branch of branchInfo.all) {
    const [primitive] = branch.split("/");
    if (!primitive) continue;
    try {
      // Get date of the latest commit on this branch
      const logOut = await git.raw(["log", "-1", "--format=%aI", branch]);
      const openedAt = logOut.trim();
      const ageH = openedAt
        ? (Date.now() - new Date(openedAt).getTime()) / 3_600_000
        : 0;
      out.push({ branch, primitive, openedAt, ageH });
    } catch {
      // skip unresolvable branches
    }
  }
  return out;
}

/**
 * Blame a specific line in a file to the commit that introduced it.
 * Uses git blame --porcelain on the bare repo.
 */
export async function blameClaim(
  branch: string,
  file: string,
  line: number,
  root: string = DEFAULT_ROOT
): Promise<{ commitHash: string; author: string; timestamp: string }> {
  const git = bareGit(root);
  const out = await git.raw([
    "blame",
    "-L",
    `${line},${line}`,
    "--porcelain",
    branch,
    "--",
    file,
  ]);
  const lines = out.split("\n");
  const hash = lines[0]?.split(" ")[0] ?? "";
  const author =
    lines.find((l) => l.startsWith("author "))?.replace("author ", "") ?? "";
  const tsStr =
    lines.find((l) => l.startsWith("author-time "))?.replace("author-time ", "") ?? "0";
  const timestamp = new Date(parseInt(tsStr, 10) * 1000).toISOString();

  return { commitHash: hash, author, timestamp };
}

/**
 * GC resolved deliberations older than olderThanDays.
 * Bundles each qualifying branch, then deletes branch + worktree.
 * If bundle creation fails, branch is preserved (fail-safe).
 */
export async function gcResolved(
  olderThanDays: number,
  root: string = DEFAULT_ROOT
): Promise<{ archivedCount: number; archivePath: string }> {
  const git = bareGit(root);
  const open = await listOpen(root);
  const cutoffMs = olderThanDays * 86_400_000;
  const ym = new Date().toISOString().slice(0, 7);
  mkdirSync(archiveRoot(root), { recursive: true });
  const archivePath = join(archiveRoot(root), `${ym}.bundle`);
  let archived = 0;

  for (const d of open) {
    // Only GC branches that have a final-memo.md (i.e., closed deliberations)
    const hasMemo =
      (
        await git
          .raw(["show", `${d.branch}:final-memo.md`])
          .catch(() => "")
      ).length > 0;
    const ageMs = Date.now() - new Date(d.openedAt).getTime();
    if (!hasMemo || ageMs < cutoffMs) continue;

    try {
      // Bundle first — if this fails, we do NOT delete the branch
      await git.raw(["bundle", "create", archivePath, d.branch]);
      await git.raw(["branch", "-D", d.branch]);
      const wt = join(worktreesRoot(root), branchToDir(d.branch));
      if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
      archived += 1;
    } catch {
      // bundle or branch delete failed → preserve (fail-safe)
      continue;
    }
  }

  // Issue 4 fix: prune stale worktree entries from the bare repo after GC loop.
  // This removes references to worktrees deleted by rmSync above.
  try {
    await git.raw(["worktree", "prune"]);
  } catch {
    // best-effort cleanup; non-fatal
  }

  return { archivedCount: archived, archivePath };
}
