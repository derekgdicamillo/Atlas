import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("beacon-export — buildPublicFiles", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "beacon-test-"));
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes roots/YYYY-MM-DD.jsonl from input roots", async () => {
    const { buildPublicFiles } = await import("../../scripts/beacon-export.ts");
    const inputRoots = [
      { ts: "2026-05-14T01:00:00.000Z", root: "abc123", entries: 100 },
      { ts: "2026-05-14T02:00:00.000Z", root: "def456", entries: 101 },
      { ts: "2026-05-15T01:00:00.000Z", root: "ghi789", entries: 105 },
    ];
    await buildPublicFiles(inputRoots, tmpDir);
    expect(existsSync(join(tmpDir, "roots", "2026-05-14.jsonl"))).toBe(true);
    expect(existsSync(join(tmpDir, "roots", "2026-05-15.jsonl"))).toBe(true);
    expect(existsSync(join(tmpDir, "roots", "latest.json"))).toBe(true);
    const latest = JSON.parse(readFileSync(join(tmpDir, "roots", "latest.json"), "utf-8"));
    expect(latest.root).toBe("ghi789");
  });

  it("idempotent: same input produces same files", async () => {
    const { buildPublicFiles } = await import("../../scripts/beacon-export.ts");
    const inputRoots = [
      { ts: "2026-05-14T01:00:00.000Z", root: "abc123", entries: 100 },
    ];
    await buildPublicFiles(inputRoots, tmpDir);
    const a = readFileSync(join(tmpDir, "roots", "2026-05-14.jsonl"), "utf-8");
    await buildPublicFiles(inputRoots, tmpDir);
    const b = readFileSync(join(tmpDir, "roots", "2026-05-14.jsonl"), "utf-8");
    expect(a).toBe(b);
  });
});

describe("beacon-export — workflow YAML round-trip", () => {
  it("publish-beacon.yml parses as valid YAML", async () => {
    const yaml = await import("js-yaml");
    const text = readFileSync(
      join(import.meta.dir, "..", "..", "templates/atlas-prime-beacon/.github/workflows/publish-beacon.yml"),
      "utf-8"
    );
    const parsed = yaml.load(text) as any;
    expect(parsed.name).toBe("publish-beacon-hourly");
    expect(parsed.on.schedule[0].cron).toBe("15 * * * *");
  });
});
