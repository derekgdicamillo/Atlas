/**
 * Atlas Teleprompter Server
 *
 * Serves the teleprompter web UI and provides an HTTP API for Atlas
 * to load scripts, control scrolling, and manage recording sessions.
 *
 * API:
 *   POST /api/load          { text, title? }     Load a script
 *   POST /api/scroll/start  {}                    Start scrolling
 *   POST /api/scroll/stop   {}                    Stop scrolling
 *   POST /api/scroll/reset  {}                    Reset to top
 *   POST /api/speed         { value }             Set scroll speed (0.1-10)
 *   POST /api/font          { size }              Set font size in px
 *   GET  /api/commands?since=N                     Long-poll for commands (used by client)
 *   GET  /api/scripts/:name                        Serve a script file from disk
 *   GET  /api/status                               Current state
 *   GET  /                                          Teleprompter UI
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const PORT = parseInt(process.env.TELEPROMPTER_PORT || "8585", 10);
const SCRIPTS_DIR = resolve(process.env.SCRIPTS_DIR || join(__dirname, "..", "scripts", "gamma-inputs"));

interface Command {
  id: number;
  type: string;
  text?: string;
  title?: string;
  value?: number;
}

let commandId = 0;
const commands: Command[] = [];
const MAX_COMMANDS = 100;

function pushCommand(cmd: Omit<Command, "id">): Command {
  const full: Command = { ...cmd, id: ++commandId };
  commands.push(full);
  if (commands.length > MAX_COMMANDS) commands.splice(0, commands.length - MAX_COMMANDS);
  return full;
}

let currentState = {
  scriptLoaded: false,
  scriptTitle: "",
  scrolling: false,
  speed: 1.0,
  fontSize: 42,
};

// Serve static files
const STATIC_DIR = resolve(__dirname);

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // Allow iPad to connect from local network

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers for local network access
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ---- API Routes ----

    if (path === "/api/load" && req.method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      const text = String(body.text || "");
      const title = String(body.title || "Untitled");
      if (!text) return Response.json({ error: "text required" }, { status: 400, headers: corsHeaders });

      pushCommand({ type: "load", text, title });
      currentState.scriptLoaded = true;
      currentState.scriptTitle = title;
      currentState.scrolling = false;
      return Response.json({ ok: true, title, chars: text.length }, { headers: corsHeaders });
    }

    if (path === "/api/scroll/start" && req.method === "POST") {
      pushCommand({ type: "start" });
      currentState.scrolling = true;
      return Response.json({ ok: true, action: "start" }, { headers: corsHeaders });
    }

    if (path === "/api/scroll/stop" && req.method === "POST") {
      pushCommand({ type: "stop" });
      currentState.scrolling = false;
      return Response.json({ ok: true, action: "stop" }, { headers: corsHeaders });
    }

    if (path === "/api/scroll/reset" && req.method === "POST") {
      pushCommand({ type: "reset" });
      currentState.scrolling = false;
      return Response.json({ ok: true, action: "reset" }, { headers: corsHeaders });
    }

    if (path === "/api/speed" && req.method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      const value = Number(body.value || 1.0);
      pushCommand({ type: "speed", value });
      currentState.speed = value;
      return Response.json({ ok: true, speed: value }, { headers: corsHeaders });
    }

    if (path === "/api/font" && req.method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      const size = Number(body.size || 42);
      pushCommand({ type: "font_size", value: size });
      currentState.fontSize = size;
      return Response.json({ ok: true, fontSize: size }, { headers: corsHeaders });
    }

    if (path === "/api/commands" && req.method === "GET") {
      const since = parseInt(url.searchParams.get("since") || "0", 10);
      const pending = commands.filter(c => c.id > since);
      return Response.json(pending, { headers: corsHeaders });
    }

    if (path.startsWith("/api/scripts/") && req.method === "GET") {
      const name = decodeURIComponent(path.replace("/api/scripts/", ""));
      // Security: prevent path traversal
      const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "");
      const filePath = join(SCRIPTS_DIR, safeName);

      if (!existsSync(filePath)) {
        // Try with .md extension
        const mdPath = filePath + ".md";
        if (existsSync(mdPath)) {
          return new Response(readFileSync(mdPath, "utf-8"), {
            headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
          });
        }
        return Response.json({ error: "script not found" }, { status: 404, headers: corsHeaders });
      }
      return new Response(readFileSync(filePath, "utf-8"), {
        headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
      });
    }

    if (path === "/api/status" && req.method === "GET") {
      return Response.json(currentState, { headers: corsHeaders });
    }

    // ---- Static Files ----
    if (path === "/" || path === "/index.html") {
      return new Response(readFileSync(join(STATIC_DIR, "index.html"), "utf-8"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[teleprompter] Server running on http://0.0.0.0:${PORT}`);
console.log(`[teleprompter] Scripts dir: ${SCRIPTS_DIR}`);
console.log(`[teleprompter] Open on iPad: http://<your-ip>:${PORT}`);
