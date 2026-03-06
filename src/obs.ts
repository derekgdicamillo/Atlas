/**
 * OBS WebSocket Integration
 *
 * Controls OBS Studio via obs-websocket-js for recording automation.
 * OBS 28+ has WebSocket server built in (Tools > WebSocket Server Settings).
 *
 * Required env:
 *   OBS_WS_URL      - WebSocket URL (default: ws://localhost:4455)
 *   OBS_WS_PASSWORD  - WebSocket password from OBS settings
 */

import OBSWebSocket from "obs-websocket-js";
import { info, warn, error as logError } from "./logger.js";

const OBS_WS_URL = process.env.OBS_WS_URL || "ws://localhost:4455";
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD || "";

let obs: OBSWebSocket | null = null;
let connected = false;

// ── Connection ─────────────────────────────────────────────

export async function connectOBS(): Promise<boolean> {
  if (connected && obs) return true;

  obs = new OBSWebSocket();

  try {
    await obs.connect(OBS_WS_URL, OBS_WS_PASSWORD || undefined);
    connected = true;
    info("obs", "Connected to OBS WebSocket");

    obs.on("ConnectionClosed", () => {
      connected = false;
      warn("obs", "Connection closed");
    });

    return true;
  } catch (err: any) {
    logError("obs", `Connection failed: ${err.message}`);
    obs = null;
    connected = false;
    return false;
  }
}

export function isConnected(): boolean {
  return connected && obs !== null;
}

export async function disconnectOBS(): Promise<void> {
  if (obs) {
    try {
      await obs.disconnect();
    } catch {}
    obs = null;
    connected = false;
  }
}

// ── Recording ──────────────────────────────────────────────

export async function startRecording(): Promise<{ ok: boolean; error?: string }> {
  if (!await ensureConnected()) return { ok: false, error: "Not connected to OBS" };

  try {
    await obs!.call("StartRecord");
    info("obs", "Recording started");
    return { ok: true };
  } catch (err: any) {
    // Already recording is fine
    if (err.message?.includes("already active")) {
      return { ok: true, error: "Already recording" };
    }
    logError("obs", `Start recording failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export async function stopRecording(): Promise<{ ok: boolean; outputPath?: string; error?: string }> {
  if (!await ensureConnected()) return { ok: false, error: "Not connected to OBS" };

  try {
    const result = await obs!.call("StopRecord");
    const outputPath = (result as any)?.outputPath || "";
    info("obs", `Recording stopped. Output: ${outputPath}`);
    return { ok: true, outputPath };
  } catch (err: any) {
    if (err.message?.includes("not active")) {
      return { ok: true, error: "Not currently recording" };
    }
    logError("obs", `Stop recording failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export async function pauseRecording(): Promise<{ ok: boolean; error?: string }> {
  if (!await ensureConnected()) return { ok: false, error: "Not connected to OBS" };

  try {
    await obs!.call("PauseRecord");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function resumeRecording(): Promise<{ ok: boolean; error?: string }> {
  if (!await ensureConnected()) return { ok: false, error: "Not connected to OBS" };

  try {
    await obs!.call("ResumeRecord");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ── Status ─────────────────────────────────────────────────

export interface OBSStatus {
  connected: boolean;
  recording: boolean;
  recordingPaused: boolean;
  recordTimecode?: string;
  currentScene?: string;
  scenes?: string[];
}

export async function getStatus(): Promise<OBSStatus> {
  if (!await ensureConnected()) {
    return { connected: false, recording: false, recordingPaused: false };
  }

  try {
    const recordStatus = await obs!.call("GetRecordStatus");
    const sceneInfo = await obs!.call("GetCurrentProgramScene");
    const sceneList = await obs!.call("GetSceneList");

    return {
      connected: true,
      recording: (recordStatus as any).outputActive || false,
      recordingPaused: (recordStatus as any).outputPaused || false,
      recordTimecode: (recordStatus as any).outputTimecode || undefined,
      currentScene: (sceneInfo as any).currentProgramSceneName || undefined,
      scenes: ((sceneList as any).scenes || []).map((s: any) => s.sceneName),
    };
  } catch (err: any) {
    logError("obs", `Status check failed: ${err.message}`);
    return { connected: true, recording: false, recordingPaused: false };
  }
}

// ── Scene Management ───────────────────────────────────────

export async function setScene(sceneName: string): Promise<{ ok: boolean; error?: string }> {
  if (!await ensureConnected()) return { ok: false, error: "Not connected to OBS" };

  try {
    await obs!.call("SetCurrentProgramScene", { sceneName });
    info("obs", `Scene set to: ${sceneName}`);
    return { ok: true };
  } catch (err: any) {
    logError("obs", `Set scene failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── Helpers ────────────────────────────────────────────────

async function ensureConnected(): Promise<boolean> {
  if (connected && obs) return true;
  return connectOBS();
}
