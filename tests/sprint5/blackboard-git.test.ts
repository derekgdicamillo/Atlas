import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import {
  initBlackboard,
  openDeliberation,
  commitContract,
  forkDissent,
  mergeDeliberation,
  walkTranscript,
  listOpen,
  blameClaim,
  gcResolved,
} from "../../src/blackboard-git";

const TEST_ROOT = join(process.cwd(), "data/test-blackboards/blackboard-git-test");

describe("blackboard-git", () => {
  beforeAll(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    await initBlackboard(TEST_ROOT);
  });
  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("opens a deliberation and creates a worktree", async () => {
    const { branch, worktreePath } = await openDeliberation(
      "test-001",
      "council",
      undefined,
      TEST_ROOT
    );
    expect(branch).toMatch(/^council\/\d{4}-\d{2}-\d{2}-test-001-[a-f0-9]{4}$/);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("commits a signed contract and returns hash + ledger entry", async () => {
    const { branch } = await openDeliberation("commit-test", "council", undefined, TEST_ROOT);
    const { commitHash, ledgerEntryId } = await commitContract(
      branch,
      {
        role_id: "test-role",
        payload: { vote: "approve", reason: "looks good" },
        signature: Buffer.from("fakesig"),
        timestamp: new Date().toISOString(),
      },
      "vote: approve",
      TEST_ROOT
    );
    expect(commitHash).toMatch(/^[a-f0-9]{40}$/);
    expect(ledgerEntryId).toBeTruthy();
  });

  it("forks dissent into a new branch", async () => {
    const { branch } = await openDeliberation("dissent-test", "joint", undefined, TEST_ROOT);
    const { newBranch } = await forkDissent(branch, "munger-inverter", "objection", TEST_ROOT);
    expect(newBranch).toMatch(/dissent/);
    expect(newBranch).not.toBe(branch);
  });

  it("merges a deliberation with a final memo", async () => {
    const { branch } = await openDeliberation("merge-test", "joint", undefined, TEST_ROOT);
    await commitContract(
      branch,
      {
        role_id: "atlas",
        payload: { proposal: "do X" },
        signature: Buffer.from("s1"),
        timestamp: new Date().toISOString(),
      },
      "proposal",
      TEST_ROOT
    );
    const { mergeCommit } = await mergeDeliberation(
      branch,
      "Final memo: do X agreed.",
      "arbitrator-opus",
      true,
      TEST_ROOT
    );
    expect(mergeCommit).toMatch(/^[a-f0-9]{40}$/);
  });

  it("walks the transcript of a branch", async () => {
    const { branch } = await openDeliberation("walk-test", "council", undefined, TEST_ROOT);
    await commitContract(
      branch,
      {
        role_id: "patient-advocate",
        payload: { vote: "veto" },
        signature: Buffer.from("s"),
        timestamp: new Date().toISOString(),
      },
      "veto",
      TEST_ROOT
    );
    const transcript = await walkTranscript(branch, TEST_ROOT);
    expect(transcript.length).toBeGreaterThanOrEqual(2); // open commit + vote commit
  });

  it("lists open deliberations", async () => {
    const open = await listOpen(TEST_ROOT);
    expect(open.length).toBeGreaterThan(0);
    expect(open[0]).toHaveProperty("branch");
    expect(open[0]).toHaveProperty("primitive");
    expect(open[0]).toHaveProperty("ageH");
  });

  it("blames a claim back to its commit", async () => {
    const { branch } = await openDeliberation("blame-test", "council", undefined, TEST_ROOT);
    await commitContract(
      branch,
      {
        role_id: "compliance-lawyer",
        payload: { claim: "PHI risk on line 7" },
        signature: Buffer.from("s"),
        timestamp: new Date().toISOString(),
      },
      "claim",
      TEST_ROOT
    );
    // Read the file written by commitContract — find first content line
    const blame = await blameClaim(branch, "contracts.jsonl", 1, TEST_ROOT);
    expect(blame.commitHash).toMatch(/^[a-f0-9]{40}$/);
    expect(blame.author).toBeTruthy();
  });
});
