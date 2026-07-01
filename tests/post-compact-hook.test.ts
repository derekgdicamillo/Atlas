import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync, copyFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = join(import.meta.dir, "..");

// Run the hook in a throwaway sandbox. The old version execSync'd with the
// ambient cwd and created/deleted memory/compact-snapshot.md relative to it —
// from the repo root that would clobber the REAL snapshot (and "restore" it
// as an empty file); from tests/ it silently tested nothing.
let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "post-compact-test-"));
  mkdirSync(join(sandbox, "scripts"), { recursive: true });
  mkdirSync(join(sandbox, "memory"), { recursive: true });
  copyFileSync(
    join(REPO_ROOT, "scripts", "post-compact-verify.sh"),
    join(sandbox, "scripts", "post-compact-verify.sh")
  );
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("post-compact-verify.sh", () => {
  test("emits re-orient instructions when snapshot exists", () => {
    writeFileSync(join(sandbox, "memory", "compact-snapshot.md"), "# test snapshot\n");
    const out = execSync("bash scripts/post-compact-verify.sh", {
      encoding: "utf8",
      cwd: sandbox,
    });
    expect(out).toContain("POST-COMPACT RE-ORIENT");
    expect(out).toContain("compact-snapshot.md");
    expect(out).toContain("MEMORY.md");
  });

  test("exits 0 even when snapshot is missing (non-blocking)", () => {
    rmSync(join(sandbox, "memory", "compact-snapshot.md"), { force: true });
    execSync("bash scripts/post-compact-verify.sh", { encoding: "utf8", cwd: sandbox });
  });
});
