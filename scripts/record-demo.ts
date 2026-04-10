/**
 * Demo Recorder — Playwright + OBS + ghost-cursor
 *
 * Records automated website walkthroughs with smooth, human-like cursor
 * movements for marketing videos. OBS captures the screen while Playwright
 * drives a visible Chrome window through scripted steps.
 *
 * Usage:
 *   bun scripts/record-demo.ts <step-file.json>        # run steps from file
 *   bun scripts/record-demo.ts --url https://example.com  # quick record a URL
 *   bun scripts/record-demo.ts --status                 # check OBS connection
 *   bun scripts/record-demo.ts --stop                   # stop OBS recording
 *
 * Requires:
 *   - OBS running with WebSocket server enabled
 *   - OBS_WS_PASSWORD in .env
 *   - Playwright + ghost-cursor installed
 */

import { chromium, type Browser, type Page } from "playwright";
import { createCursor, type GhostCursor } from "ghost-cursor";
import OBSWebSocket from "obs-websocket-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

// ── Types ─────────────────────────────────────────────────

interface DemoStep {
  action: "navigate" | "click" | "scroll" | "wait" | "type" | "hover" | "screenshot" | "scene" | "highlight" | "scroll-to";
  // navigate
  url?: string;
  // click, hover, type, highlight, scroll-to
  selector?: string;
  // type
  text?: string;
  delay?: number; // ms between keystrokes
  // scroll
  y?: number; // pixels to scroll (positive = down)
  x?: number;
  smooth?: boolean; // default true
  // wait
  ms?: number;
  // screenshot
  name?: string;
  // scene (OBS scene switch)
  sceneName?: string;
  // highlight: flash a CSS outline around element
  color?: string; // default "red"
  duration?: number; // ms, default 2000
  // description for logging
  label?: string;
}

interface DemoConfig {
  name: string;
  url: string;
  viewport?: { width: number; height: number };
  steps: DemoStep[];
  obs?: {
    scene?: string; // starting scene
    recordOnStart?: boolean; // default true
  };
}

// ── OBS Connection ────────────────────────────────────────

const OBS_WS_URL = process.env.OBS_WS_URL || "ws://localhost:4455";
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD || "";

let obs: OBSWebSocket | null = null;

async function connectOBS(): Promise<boolean> {
  obs = new OBSWebSocket();
  try {
    await obs.connect(OBS_WS_URL, OBS_WS_PASSWORD || undefined);
    console.log("✓ Connected to OBS");
    return true;
  } catch (err: any) {
    console.error(`✗ OBS connection failed: ${err.message}`);
    console.error("  Make sure OBS is running with WebSocket server enabled");
    obs = null;
    return false;
  }
}

async function obsStartRecording(): Promise<void> {
  if (!obs) return;
  try {
    await obs.call("StartRecord");
    console.log("✓ OBS recording started");
  } catch (err: any) {
    if (err.message?.includes("already active")) {
      console.log("⚠ OBS already recording");
    } else {
      throw err;
    }
  }
}

async function obsStopRecording(): Promise<string | undefined> {
  if (!obs) return;
  try {
    const result = await obs.call("StopRecord");
    const outputPath = (result as any)?.outputPath;
    console.log(`✓ OBS recording stopped${outputPath ? `: ${outputPath}` : ""}`);
    return outputPath;
  } catch (err: any) {
    if (err.message?.includes("not active")) {
      console.log("⚠ OBS not recording");
    } else {
      throw err;
    }
  }
}

async function obsSetScene(sceneName: string): Promise<void> {
  if (!obs) return;
  await obs.call("SetCurrentProgramScene", { sceneName });
  console.log(`✓ OBS scene: ${sceneName}`);
}

async function obsGetStatus(): Promise<any> {
  if (!obs) return { connected: false };
  try {
    const rec = await obs.call("GetRecordStatus");
    const scene = await obs.call("GetCurrentProgramScene");
    const scenes = await obs.call("GetSceneList");
    return {
      connected: true,
      recording: (rec as any).outputActive,
      paused: (rec as any).outputPaused,
      timecode: (rec as any).outputTimecode,
      scene: (scene as any).currentProgramSceneName,
      scenes: ((scenes as any).scenes || []).map((s: any) => s.sceneName),
    };
  } catch {
    return { connected: true, recording: false };
  }
}

// ── Smooth Scrolling ──────────────────────────────────────

async function smoothScroll(page: Page, deltaY: number, deltaX = 0, durationMs = 800): Promise<void> {
  const steps = Math.max(10, Math.floor(durationMs / 16)); // ~60fps
  const stepY = deltaY / steps;
  const stepX = deltaX / steps;

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(stepX, stepY);
    await page.waitForTimeout(16);
  }
}

// ── Highlight Effect ──────────────────────────────────────

async function highlightElement(page: Page, selector: string, color = "red", durationMs = 2000): Promise<void> {
  await page.evaluate(
    ({ sel, col, dur }) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (!el) return;
      const orig = el.style.outline;
      const origTransition = el.style.transition;
      el.style.transition = "outline 0.3s ease";
      el.style.outline = `3px solid ${col}`;
      setTimeout(() => {
        el.style.outline = orig;
        el.style.transition = origTransition;
      }, dur);
    },
    { sel: selector, col: color, dur: durationMs }
  );
}

// ── Step Executor ─────────────────────────────────────────

async function executeStep(page: Page, cursor: GhostCursor, step: DemoStep, index: number): Promise<void> {
  const label = step.label || `Step ${index + 1}: ${step.action}`;
  console.log(`  → ${label}`);

  switch (step.action) {
    case "navigate":
      await page.goto(step.url!, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1000); // let page settle
      break;

    case "click":
      await page.waitForSelector(step.selector!, { timeout: 10000 });
      const clickEl = await page.$(step.selector!);
      if (clickEl) {
        await cursor.click(clickEl);
      }
      await page.waitForTimeout(500);
      break;

    case "hover":
      await page.waitForSelector(step.selector!, { timeout: 10000 });
      const hoverEl = await page.$(step.selector!);
      if (hoverEl) {
        await cursor.move(hoverEl);
      }
      await page.waitForTimeout(300);
      break;

    case "type":
      await page.waitForSelector(step.selector!, { timeout: 10000 });
      const typeEl = await page.$(step.selector!);
      if (typeEl) {
        await cursor.click(typeEl);
        await page.waitForTimeout(200);
        await page.keyboard.type(step.text!, { delay: step.delay || 80 });
      }
      break;

    case "scroll":
      if (step.smooth !== false) {
        await smoothScroll(page, step.y || 0, step.x || 0);
      } else {
        await page.mouse.wheel(step.x || 0, step.y || 0);
      }
      await page.waitForTimeout(300);
      break;

    case "scroll-to":
      await page.waitForSelector(step.selector!, { timeout: 10000 });
      await page.evaluate((sel) => {
        document.querySelector(sel)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, step.selector!);
      await page.waitForTimeout(800);
      break;

    case "wait":
      await page.waitForTimeout(step.ms || 1000);
      break;

    case "screenshot":
      const ssName = step.name || `demo-screenshot-${index}`;
      const ssPath = resolve(dirname(""), `scripts/demo-steps/${ssName}.png`);
      await page.screenshot({ path: ssPath, fullPage: false });
      console.log(`    📸 Saved: ${ssPath}`);
      break;

    case "scene":
      await obsSetScene(step.sceneName!);
      break;

    case "highlight":
      await highlightElement(page, step.selector!, step.color, step.duration);
      await page.waitForTimeout(step.duration || 2000);
      break;

    default:
      console.warn(`    ⚠ Unknown action: ${step.action}`);
  }
}

// ── Main Runner ───────────────────────────────────────────

async function runDemo(config: DemoConfig): Promise<void> {
  console.log(`\n🎬 Demo: ${config.name}`);
  console.log(`   URL: ${config.url}`);
  console.log(`   Steps: ${config.steps.length}\n`);

  // Connect OBS
  const obsOk = await connectOBS();

  // Launch browser (visible, not headless)
  const viewport = config.viewport || { width: 1920, height: 1080 };
  const browser: Browser = await chromium.launch({
    headless: false,
    args: [
      `--window-size=${viewport.width},${viewport.height}`,
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
    ],
  });

  const context = await browser.newContext({
    viewport,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  const cursor = createCursor(page);

  try {
    // Set OBS scene if specified
    if (obsOk && config.obs?.scene) {
      await obsSetScene(config.obs.scene);
      await new Promise((r) => setTimeout(r, 500));
    }

    // Navigate to starting URL
    console.log(`  → Navigating to ${config.url}`);
    await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000); // let page fully render

    // Start OBS recording
    if (obsOk && config.obs?.recordOnStart !== false) {
      await obsStartRecording();
      await new Promise((r) => setTimeout(r, 1000)); // buffer before demo starts
    }

    // Execute steps
    for (let i = 0; i < config.steps.length; i++) {
      await executeStep(page, cursor, config.steps[i], i);
    }

    // Final pause before stopping
    await page.waitForTimeout(2000);

    // Stop recording
    if (obsOk) {
      const outputPath = await obsStopRecording();
      if (outputPath) {
        console.log(`\n✅ Recording saved: ${outputPath}`);
      }
    }
  } catch (err: any) {
    console.error(`\n✗ Demo failed: ${err.message}`);
    // Try to stop recording on failure
    if (obsOk) await obsStopRecording();
    throw err;
  } finally {
    await browser.close();
    if (obs) {
      try { await obs.disconnect(); } catch {}
    }
  }

  console.log("\n✅ Demo complete!");
}

// ── CLI ───────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // --status: just check OBS
  if (args.includes("--status")) {
    const ok = await connectOBS();
    if (ok) {
      const status = await obsGetStatus();
      console.log(JSON.stringify(status, null, 2));
      await obs!.disconnect();
    }
    process.exit(0);
  }

  // --stop: stop OBS recording
  if (args.includes("--stop")) {
    const ok = await connectOBS();
    if (ok) {
      await obsStopRecording();
      await obs!.disconnect();
    }
    process.exit(0);
  }

  // --url: quick record of a single URL
  const urlIdx = args.indexOf("--url");
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    const url = args[urlIdx + 1];
    await runDemo({
      name: `Quick recording: ${url}`,
      url,
      steps: [
        { action: "wait", ms: 3000, label: "Initial view" },
        { action: "scroll", y: 600, label: "Scroll down" },
        { action: "wait", ms: 2000 },
        { action: "scroll", y: 600, label: "Scroll more" },
        { action: "wait", ms: 2000 },
        { action: "scroll", y: 600, label: "Scroll more" },
        { action: "wait", ms: 2000 },
        { action: "scroll", y: -1800, label: "Scroll back to top" },
        { action: "wait", ms: 2000 },
      ],
    });
    process.exit(0);
  }

  // Step file argument
  const stepFile = args[0];
  if (!stepFile) {
    console.log("Usage:");
    console.log("  bun scripts/record-demo.ts <step-file.json>");
    console.log("  bun scripts/record-demo.ts --url https://example.com");
    console.log("  bun scripts/record-demo.ts --status");
    console.log("  bun scripts/record-demo.ts --stop");
    process.exit(1);
  }

  // Resolve step file path
  let filePath = stepFile;
  if (!existsSync(filePath)) {
    filePath = resolve("scripts/demo-steps", stepFile);
  }
  if (!existsSync(filePath)) {
    filePath = resolve("scripts/demo-steps", `${stepFile}.json`);
  }
  if (!existsSync(filePath)) {
    console.error(`✗ Step file not found: ${stepFile}`);
    console.error("  Looked in: scripts/demo-steps/");
    process.exit(1);
  }

  const config: DemoConfig = JSON.parse(readFileSync(filePath, "utf-8"));
  await runDemo(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
