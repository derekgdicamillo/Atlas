/**
 * Otter.ai API Client for Bun/TypeScript
 * Ported from the unofficial Python client (gmchad/otterai-api).
 * Session-cookie auth, no official API key.
 */

const API_BASE = "https://otter.ai/forward/api/v1/";

interface OtterSession {
  userid: string;
  cookies: Record<string, string>;
  headers: Record<string, string>;
}

export interface OtterSpeech {
  otid: string;
  title: string;
  created_at: number;
  duration: number;
  summary?: string;
  speaker_names?: string[];
}

export interface OtterTranscriptSegment {
  speaker_name: string;
  transcript: string;
  start_offset?: number;
  end_offset?: number;
}

export interface OtterSpeechDetail {
  otid: string;
  title: string;
  created_at: number;
  duration: number;
  summary?: string;
  transcripts: OtterTranscriptSegment[];
}

export interface OtterSearchHit {
  speech_otid: string;
  title: string;
  speaker: string[];
  start_time: number;
  duration: number;
  matched_transcripts: Array<{
    matched_transcript: string;
    speaker_name: string;
  }>;
}

let session: OtterSession | null = null;

function parseCookies(setCookieHeaders: string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of setCookieHeaders) {
    const match = header.match(/^([^=]+)=([^;]*)/);
    if (match) cookies[match[1]] = match[2];
  }
  return cookies;
}

function cookieString(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export async function otterLogin(): Promise<OtterSession> {
  const email = process.env.OTTER_EMAIL;
  // Password stored as base64 to avoid dotenv mangling special chars ($$)
  const pwB64 = process.env.OTTER_PASSWORD_B64;
  const password = pwB64 ? atob(pwB64) : process.env.OTTER_PASSWORD;
  if (!email || !password) {
    throw new Error("OTTER_EMAIL and OTTER_PASSWORD_B64 env vars required");
  }

  const authHeader = "Basic " + btoa(`${email}:${password}`);
  const url = `${API_BASE}login?username=${encodeURIComponent(email)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: authHeader,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://otter.ai/",
      Origin: "https://otter.ai",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Otter login failed: ${res.status} ${body.substring(0, 200)}`);
  }

  const data = await res.json();
  const setCookies = res.headers.getSetCookie?.() || [];
  const cookies = parseCookies(setCookies);

  session = {
    userid: data.userid,
    cookies,
    headers: {
      Cookie: cookieString(cookies),
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://otter.ai/",
    },
  };

  return session;
}

async function getSession(): Promise<OtterSession> {
  if (!session) {
    return otterLogin();
  }
  return session;
}

async function otterGet(endpoint: string, params: Record<string, string | number> = {}): Promise<any> {
  const s = await getSession();
  const url = new URL(API_BASE + endpoint);
  url.searchParams.set("userid", s.userid);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), { headers: s.headers });

  if (res.status === 401) {
    // Session expired, re-login once
    session = null;
    const s2 = await getSession();
    const res2 = await fetch(url.toString(), { headers: s2.headers });
    if (!res2.ok) throw new Error(`Otter API ${endpoint}: ${res2.status}`);
    return res2.json();
  }

  if (!res.ok) throw new Error(`Otter API ${endpoint}: ${res.status}`);
  return res.json();
}

/** List recent transcripts */
export async function listSpeeches(pageSize = 20): Promise<OtterSpeech[]> {
  const data = await otterGet("speeches", { page_size: pageSize, folder: 0, source: "owned" });
  return (data.speeches || []).map((s: any) => ({
    otid: s.otid,
    title: s.title || "Untitled",
    created_at: s.created_at || 0,
    duration: s.duration || 0,
    summary: s.summary || "",
    speaker_names: s.speaker_names || [],
  }));
}

/** Get full transcript for a speech */
export async function getSpeech(otid: string): Promise<OtterSpeechDetail> {
  const data = await otterGet("speech", { otid });
  const speech = data.speech || data;
  return {
    otid: speech.otid || otid,
    title: speech.title || "Untitled",
    created_at: speech.created_at || 0,
    duration: speech.duration || 0,
    summary: speech.summary || "",
    transcripts: (speech.transcripts || []).map((t: any) => ({
      speaker_name: t.speaker_name || "Speaker",
      transcript: t.transcript || "",
      start_offset: t.start_offset,
      end_offset: t.end_offset,
    })),
  };
}

/** Search across all transcripts */
export async function searchSpeeches(query: string, size = 20): Promise<OtterSearchHit[]> {
  const s = await getSession();
  const url = new URL(API_BASE + "advanced_search");
  url.searchParams.set("query", query);
  url.searchParams.set("size", String(size));

  const res = await fetch(url.toString(), { headers: s.headers });
  if (!res.ok) return [];

  const data = await res.json();
  return (data.hits || []).map((h: any) => ({
    speech_otid: h.speech_otid,
    title: h.title || "Untitled",
    speaker: h.speaker || [],
    start_time: h.start_time || 0,
    duration: h.duration || 0,
    matched_transcripts: (h.matched_transcripts || []).map((mt: any) => ({
      matched_transcript: mt.matched_transcript || "",
      speaker_name: mt.speaker_name || "Unknown",
    })),
  }));
}

/** Format duration seconds to human readable */
export function formatDuration(seconds: number): string {
  if (!seconds) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Format transcript to plain text with speaker labels */
export function transcriptToText(speech: OtterSpeechDetail): string {
  if (!speech.transcripts.length) return "(empty transcript)";
  return speech.transcripts
    .map((t) => `[${t.speaker_name}]: ${t.transcript}`)
    .join("\n\n");
}
