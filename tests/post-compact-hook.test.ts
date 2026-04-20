import { describe, test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";

describe("post-compact-verify.sh", () => {
  test("emits re-orient instructions when snapshot exists", () => {
    mkdirSync("memory", { recursive: true });
    const existed = existsSync("memory/compact-snapshot.md");
    if (!existed) writeFileSync("memory/compact-snapshot.md", "# test snapshot\n");
    try {
      const out = execSync("bash scripts/post-compact-verify.sh", { encoding: "utf8" });
      expect(out).toContain("POST-COMPACT RE-ORIENT");
      expect(out).toContain("compact-snapshot.md");
      expect(out).toContain("MEMORY.md");
    } finally {
      if (!existed) rmSync("memory/compact-snapshot.md");
    }
  });

  test("exits 0 even when snapshot is missing (non-blocking)", () => {
    const existed = existsSync("memory/compact-snapshot.md");
    if (existed) rmSync("memory/compact-snapshot.md");
    try {
      execSync("bash scripts/post-compact-verify.sh", { encoding: "utf8" });
    } finally {
      if (existed) writeFileSync("memory/compact-snapshot.md", "");
    }
  });
});
