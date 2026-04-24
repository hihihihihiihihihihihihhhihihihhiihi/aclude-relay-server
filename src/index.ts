/**
 * Aclude Relay Server
 *
 * Bridges a browser terminal (xterm.js) to Claude Code running on a VM.
 * - WebSocket on port 8080 for terminal I/O and control messages
 * - PTY sessions via node-pty
 * - File watching via chokidar for bidirectional file sync
 * - Health check endpoint at GET /health
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as os from "os";
import * as fs from "fs";
import { validateAuth } from "./auth";
import { Session } from "./session";
import { createApiProxy, type ApiProxy } from "./api-proxy";
import {
  FileWatcher,
  handleFileWrite,
  handleFileWriteBinary,
} from "./file-watcher";

const PORT = parseInt(process.env.PORT || "8080", 10);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const CLAUDE_HOMES_DIR = process.env.CLAUDE_HOMES_DIR || "/home/ubuntu/claude-homes";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const SESSION_SNAPSHOT_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 45_000;  // Check less often — background tabs throttle timers
const HEARTBEAT_TIMEOUT_MS = 120_000;  // Very tolerant — tab switching shouldn't disconnect
const RECONNECT_GRACE_MS = 30_000;     // Don't wipe workspace for 30s after disconnect

// --- Session tracking ---
// Upgraded from Set<WebSocket> to Map<WebSocket, SessionMeta> so the new
// GET /sessions endpoint can return per-session metadata (sessionId,
// projectId, startedAt). .size/.delete still work on Map like they did on
// Set, so existing cleanup code is untouched.
interface SessionMeta {
  sessionId: string | null;
  projectId: string | null;
  userId: string | null;
  startedAt: number;
  remoteAddr: string;
}
const activeSessions = new Map<WebSocket, SessionMeta>();
const startTime = Date.now();

// --- Disk free helper ---
// Uses fs.statfs (Node 18+) for the workspace mount. Returns null on platforms
// that don't support it (statfs throws on Windows prior to Node 22).
function getDiskStats(path: string): { total: number; free: number; used: number; usedPercent: number } | null {
  try {
    // fs.statfsSync returns an object with { bavail, bfree, blocks, bsize, ... }
    // https://nodejs.org/api/fs.html#fsstatfssyncpath-options
    const s = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; blocks: number; bsize: number } }).statfsSync?.(path);
    if (!s) return null;
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - free;
    return {
      total,
      free,
      used,
      usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
  } catch {
    return null;
  }
}

// --- Network bytes helper ---
// Reads /proc/net/dev (Linux only) and returns cumulative rx/tx bytes
// summed across all non-loopback interfaces. Clients compute rate deltas
// from their own poll cadence, so we don't need a server-side ring buffer.
function getNetworkBytes(): { rxBytes: number; txBytes: number } | null {
  try {
    const raw = fs.readFileSync("/proc/net/dev", "utf-8");
    const lines = raw.split("\n").slice(2); // skip 2 header lines
    let rx = 0;
    let tx = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [iface, rest] = trimmed.split(/:\s*/);
      if (!iface || !rest || iface === "lo") continue;
      const cols = rest.split(/\s+/);
      // cols[0] = rx bytes, cols[8] = tx bytes
      rx += parseInt(cols[0] || "0", 10) || 0;
      tx += parseInt(cols[8] || "0", 10) || 0;
    }
    return { rxBytes: rx, txBytes: tx };
  } catch {
    return null;
  }
}

// --- Reconnect grace period ---
// When a client disconnects, we defer the wipe for RECONNECT_GRACE_MS.
// If the same projectId reconnects within that window, we cancel the wipe
// and reuse the existing workspace + session data on disk.
interface PendingCleanup {
  timer: NodeJS.Timeout;
  projectDir: string;
  userHomeDir: string;
  userId: string;
  savedToSupabase: boolean; // true once async Supabase save finishes
}
const pendingCleanups = new Map<string, PendingCleanup>();

// --- Auto-continue on max_tokens ---
// Claude Code's API call ends with stop_reason: "max_tokens" when the output
// token budget is hit mid-response. We send "continue" via PTY stdin so the
// user doesn't have to. Capped per session to prevent a runaway loop.
const MAX_AUTO_CONTINUES = 3;
const AUTO_CONTINUE_DELAY_MS = 800; // wait for CLI to settle before typing

// --- HTTP server (health check) ---

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET" && req.url === "/health") {
    // Gather system stats from Node's os module (zero external deps).
    // Consumers: the Aclude /admin/vms dashboard aggregates memory/CPU
    // across multiple workers (Oracle + PC), so we expose absolute bytes
    // + a pre-computed usedPercent so clients don't all reinvent the math.
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    // CPU percent from 1-minute load average / cores.
    // Note: this is a rough proxy (loadavg isn't a real CPU%),
    // but it's the cheapest metric available without sampling.
    const cpuUsedPercent = Math.min(
      100,
      Math.round((loadAvg[0] / Math.max(1, cpus.length)) * 1000) / 10,
    );
    const processUptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const systemUptimeSec = Math.floor(os.uptime());

    // New: disk, process heap, network bytes
    const disk = getDiskStats(WORKSPACE_DIR);
    const procMem = process.memoryUsage();
    const network = getNetworkBytes();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        activeSessions: activeSessions.size,
        uptime: processUptimeSec, // relay process uptime (kept for back-compat)
        memory: {
          total: totalMem,
          used: usedMem,
          free: freeMem,
          usedPercent: Math.round((usedMem / totalMem) * 1000) / 10,
        },
        cpu: {
          cores: cpus.length,
          model: cpus[0]?.model?.trim() || "unknown",
          loadAvg1: loadAvg[0],
          loadAvg5: loadAvg[1],
          loadAvg15: loadAvg[2],
          usedPercent: cpuUsedPercent,
        },
        system: {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          uptime: systemUptimeSec, // host uptime, not the relay process
          release: os.release(),
        },
        // New fields — dashboard gates rendering on existence so old
        // relay builds still work with the updated dashboard.
        disk: disk ?? undefined,
        process: {
          heapUsed: procMem.heapUsed,
          heapTotal: procMem.heapTotal,
          rss: procMem.rss,
          external: procMem.external,
          pid: process.pid,
        },
        network: network ?? undefined,
      }),
    );
    return;
  }

  // GET /sessions — returns metadata for every active WebSocket session.
  // The dashboard's "active session list per worker" expands each worker
  // card to show which sessionIds are currently connected. Fast (O(n) over
  // the active set, no I/O), auth is handled by a query-string api key to
  // stay compatible with the same auth model as WebSocket /ws?apiKey=...
  if (req.method === "GET" && req.url?.startsWith("/sessions")) {
    // Parse api key from query string — mirrors the WebSocket auth path.
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const apiKey = url.searchParams.get("apiKey") || "";
    const expected = process.env.RELAY_API_KEY || "";
    // If RELAY_API_KEY isn't set, skip auth (same as ws auth fallback).
    if (expected && apiKey !== expected) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const nowMs = Date.now();
    const sessions: Array<{
      sessionId: string | null;
      projectId: string | null;
      userId: string | null;
      startedAt: number;
      uptimeSec: number;
      remoteAddr: string;
    }> = [];
    for (const meta of activeSessions.values()) {
      sessions.push({
        sessionId: meta.sessionId,
        projectId: meta.projectId,
        userId: meta.userId,
        startedAt: meta.startedAt,
        uptimeSec: Math.floor((nowMs - meta.startedAt) / 1000),
        remoteAddr: meta.remoteAddr,
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions, count: sessions.length }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// --- WebSocket server ---

const wss = new WebSocketServer({ server });

wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
  // Validate auth
  if (!validateAuth(req)) {
    console.warn("[ws] Auth failed, closing connection");
    ws.close(4001, "Unauthorized");
    return;
  }

  // Parse initial options from query params
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const cols = parseInt(url.searchParams.get("cols") || "80", 10);
  const rows = parseInt(url.searchParams.get("rows") || "24", 10);
  const apiKey = url.searchParams.get("apiKey") || undefined;
  const sessionId = url.searchParams.get("sessionId") || undefined;
  const userId = url.searchParams.get("userId") || undefined;
  const projectId = sessionId; // sessionId doubles as projectId for workspace isolation

  // Record this session in the active map WITH metadata. The new
  // GET /sessions endpoint reads this map so the dashboard can show
  // which specific sessions are connected (not just a count).
  activeSessions.set(ws, {
    sessionId: sessionId ?? null,
    projectId: projectId ?? null,
    userId: userId ?? null,
    startedAt: Date.now(),
    remoteAddr:
      (req.socket.remoteAddress ?? "") +
      (req.socket.remotePort ? `:${req.socket.remotePort}` : ""),
  });
  console.log(`[ws] Client connected (active: ${activeSessions.size})`);

  // Per-project workspace isolation: /workspace/{projectId}/
  // Each project gets its own directory so files never mix between projects.
  const projectDir = sessionId
    ? `${WORKSPACE_DIR}/${sessionId}`
    : WORKSPACE_DIR;

  // Per-PROJECT HOME isolation: /home/ubuntu/claude-homes/{userId}/{projectId}/
  // Each project gets its own Claude Code config dir so cleanup races can't
  // wipe a home out from under another running session. Single-owner = no
  // ref-counting needed. Nothing leaks between projects or between users.
  const userHomeDir = userId && sessionId
    ? `${CLAUDE_HOMES_DIR}/${userId}/${sessionId}`
    : process.env.HOME || "/home/node";

  const cleanupKey = projectId || "";

  // --- Check for reconnect within grace period ---
  // If the same project reconnects before the wipe timer fires, cancel
  // the wipe and reuse the existing workspace + session data on disk.
  const pending = cleanupKey ? pendingCleanups.get(cleanupKey) : undefined;
  let reusingWorkspace = false;
  if (pending) {
    clearTimeout(pending.timer);
    pendingCleanups.delete(cleanupKey);
    reusingWorkspace = true;
    console.log(`[ws] Reconnect within grace period — reusing workspace for ${cleanupKey}`);
  }

  // Ensure directories exist
  const { mkdirSync, writeFileSync, existsSync } = await import("fs");
  try { mkdirSync(projectDir, { recursive: true }); } catch {}
  try { mkdirSync(userHomeDir, { recursive: true }); } catch {}

  // Pre-seed Claude Code config so it doesn't ask setup questions
  // (theme, API key, folder trust) on first run.
  const claudeDir = `${userHomeDir}/.claude`;
  try { mkdirSync(claudeDir, { recursive: true }); } catch {}
  const settingsPath = `${claudeDir}/settings.json`;
  // Accept terms, trust workspace, and pre-configure API key so Claude Code
  // starts without ANY interactive prompts. VM is wiped after each session.
  //
  // Auth source of truth:
  //   - OAuth tokens (sk-ant-oat01-*) → passed via CLAUDE_CODE_OAUTH_TOKEN
  //     env var in session.ts. We do NOT write primaryApiKey in that case
  //     because it's the wrong field for OAuth and having two competing
  //     sources of truth was producing intermittent "Not logged in" errors.
  //   - Real API keys (sk-ant-api03-*) → written to primaryApiKey here.
  //     Still the right path for API-key auth — no env var in that case
  //     because Claude Code would show an interactive prompt.
  const termsPath = `${userHomeDir}/.claude.json`;
  const isOAuthToken = typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
  const claudeJson: Record<string, unknown> = {
    hasAcknowledgedCostThreshold: true,
    hasCompletedOnboarding: true,
    hasVisitedExtraUsage: true,
    // CRITICAL: acknowledges the "you are using bypass mode" warning that
    // Claude Code shows on first use of `--dangerously-skip-permissions`.
    // Without this, the flag passes the CLI parse but the runtime still
    // gates every tool call on the un-accepted warning dialog — which
    // surfaces in the TUI as the "Do you want to create index.html? 1/2/3"
    // prompts we're trying to eliminate.
    bypassPermissionsModeAccepted: true,
    projects: {
      [projectDir]: {
        allowedTools: ["*"],
        // AskUserQuestion is blocked because Claude Code only writes the
        // tool_use to the JSONL AFTER the user answers in the terminal —
        // so the UI chat panel never sees it in time to render the card.
        // Until we can intercept the PTY stream in real-time, the tool
        // just confuses users (they see a prompt in the terminal but
        // nothing in the chat).
        deniedTools: ["AskUserQuestion"],
        hasTrustDialogAccepted: true,
        // Per-project bypass acceptance — some Claude Code versions check
        // this per-project in addition to the top-level flag, so we set
        // it here too. Extra fields are ignored if not used.
        bypassPermissionsModeAccepted: true,
      }
    },
  };
  if (apiKey && !isOAuthToken) {
    claudeJson.primaryApiKey = apiKey;
  }
  writeFileSync(termsPath, JSON.stringify(claudeJson), "utf-8");
  // Also rewrite settings every time (user home was cleaned).
  // `permissions.defaultMode: "bypassPermissions"` is the documented
  // settings-file way to make bypass the default — belt-and-braces with
  // the `--dangerously-skip-permissions` CLI flag we pass in session.ts.
  writeFileSync(settingsPath, JSON.stringify({
    theme: "dark",
    preferredNotifChannel: "terminal",
    hasCompletedOnboarding: true,
    autoUpdaterStatus: "disabled",
    permissions: {
      defaultMode: "bypassPermissions",
    },
    statusLine: {
      type: "command",
      command: "ccstatusline --config ~/.ccsl-aclude.json",
      padding: 0,
    },
  }), "utf-8");

  // Write ccstatusline config to a dedicated path (~/.ccsl-aclude.json) and
  // point the statusLine command at it via --config. This bypasses the default
  // ~/.config/ccstatusline/settings.json which gets overwritten by ccstatusline's
  // first-run initialization during Claude Code startup.
  writeFileSync(`${userHomeDir}/.ccsl-aclude.json`, JSON.stringify({
    version: 3,
    lines: [
      [
        { id: "1", type: "block-timer", color: "cyan" },
        { id: "2", type: "separator" },
        { id: "3", type: "context-bar", color: "brightBlack" },
        { id: "4", type: "separator" },
        { id: "5", type: "model", color: "magenta" },
        { id: "6", type: "separator" },
        { id: "7", type: "tokens-output", color: "yellow" },
      ],
      [
        { id: "8", type: "output-speed" },
        { id: "9", type: "separator" },
        { id: "10", type: "session-cost" },
        { id: "11", type: "separator" },
        { id: "12", type: "tokens-input" },
        { id: "13", type: "separator" },
        { id: "14", type: "tokens-output" },
        { id: "15", type: "separator" },
        { id: "16", type: "thinking-effort" },
        { id: "17", type: "separator" },
        { id: "18", type: "claude-session-id" },
      ],
      [],
    ],
    flexMode: "full-until-compact",
    compactThreshold: 30,
    colorLevel: 2,
    inheritSeparatorColors: false,
    globalBold: false,
    minimalistMode: true,
    powerline: {
      enabled: false,
      separators: [""],
      separatorInvertBackground: [false],
      startCaps: [],
      endCaps: [],
      autoAlign: false,
      continueThemeAcrossLines: false,
    },
  }), "utf-8");

  // Write a CLAUDE.md in the workspace with instructions for the harness.
  // This is the most reliable way to configure Claude Code's behavior —
  // it reads CLAUDE.md as system-level instructions on every turn.
  const claudeMdPath = `${projectDir}/CLAUDE.md`;
  try {
    // Only write if it doesn't exist (don't overwrite user's own CLAUDE.md)
    if (!existsSync(claudeMdPath)) {
      writeFileSync(claudeMdPath, [
        "# Aclude Harness Instructions",
        "",
        "## Runtime Constraint",
        "",
        "ALWAYS build web applications using Node.js (Express, Next.js, Vite,",
        "React, etc.). NEVER use Python, Flask, Django, Ruby, Go, or any other",
        "non-Node.js runtime. The preview system only supports Node.js — apps",
        "built with other runtimes will not be visible to the user.",
        "",
        "## File Location",
        "",
        "ALWAYS place package.json and all project files in the CURRENT WORKING",
        "DIRECTORY (the workspace root). NEVER create a subdirectory for the",
        "project — the preview system expects package.json at the root.",
        "",
        "## Banned Tools",
        "",
        "NEVER use the `AskUserQuestion` tool. It blocks the terminal waiting",
        "for user input that the UI cannot surface in real-time. If you need",
        "clarification from the user, ask in your text response instead.",
        "",
      ].join("\n"), "utf-8");
    }
  } catch {
    // Non-critical — Claude Code still works without it
  }

  console.log(`[ws] Project workspace: ${projectDir}`);
  console.log(`[ws] User HOME: ${userHomeDir}`);

  // Start file watcher
  const fileWatcher = new FileWatcher(ws, projectDir);

  // Track whether we restored an existing session (controls --continue flag)
  // If we're reusing the workspace from a grace period reconnect, session
  // data is already on disk — Claude Code can --continue without any restore.
  let hasExistingSession = reusingWorkspace;
  let sessionSpawned = false;
  let apiProxy: ApiProxy | null = null;

  // Counter for consecutive max_tokens auto-continues. Reset on clean
  // end_turn or whenever the user types fresh input (Enter keypress).
  let autoContinueCount = 0;

  const scheduleAutoContinue = () => {
    if (autoContinueCount >= MAX_AUTO_CONTINUES) {
      console.log(`[ws] auto-continue cap reached (${MAX_AUTO_CONTINUES}) — skipping`);
      return;
    }
    autoContinueCount++;
    const attempt = autoContinueCount;
    console.log(`[ws] Scheduling auto-continue #${attempt} (max_tokens stop_reason)`);
    setTimeout(() => {
      if (cleanedUp) return;
      const s = (cleanup as unknown as { _session?: Session })._session;
      if (!s) return;
      // Literal "continue" + carriage return, like a user typing it.
      s.write("continue\r");
      console.log(`[ws] auto-continue #${attempt} sent`);
    }, AUTO_CONTINUE_DELAY_MS);
  };

  const spawnSession = async () => {
    if (sessionSpawned) return;
    sessionSpawned = true;

    // Start API proxy for SSE interception (non-fatal — session works without it)
    let proxyPort: number | undefined;
    try {
      apiProxy = createApiProxy({
        port: 0,  // auto-assign
        onEvent: (event) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "chat-event", event }));
          }
        },
        onUserMessage: (text) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "chat-user-message", text }));
          }
        },
        onStreamStart: () => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "chat-stream-start" }));
          }
        },
        onStreamEnd: ({ stopReason }) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "chat-stream-end" }));
          }
          // Clean natural finish — allow fresh auto-continue budget next time.
          if (stopReason === "end_turn") {
            autoContinueCount = 0;
          }
          // Claude hit the per-response output cap — auto-type "continue"
          // so long outputs resume without manual intervention.
          if (stopReason === "max_tokens") {
            scheduleAutoContinue();
          }
        },
      });
      proxyPort = await apiProxy.start();
      console.log(`[relay] API proxy started on port ${proxyPort}`);
    } catch (err) {
      console.error("[relay] API proxy failed to start (continuing without it):", err);
      apiProxy = null;
    }

    // Create session with the knowledge of whether history exists
    const session_instance = new Session(ws, {
      cols,
      rows,
      workspaceDir: projectDir,
      apiKey,
      sessionId,
      hasExistingSession,
      env: { HOME: userHomeDir },
      proxyPort,
    });
    // Store on outer scope so cleanup can access it
    (cleanup as any)._session = session_instance;

    try {
      await session_instance.spawn();
      await fileWatcher.start();
      await startSessionWatcher();
      console.log(`[ws] Session spawned (hasExistingSession: ${hasExistingSession})`);
    } catch (err) {
      console.error("[ws] Failed to initialize session:", err);
      ws.close(4002, "Session initialization failed");
      activeSessions.delete(ws);
    }
  };

  // Wait for restore-session from browser before spawning.
  // Fallback: 10s timeout (generous — browser fetches from Supabase first).
  const spawnTimeout = setTimeout(() => {
    console.log("[ws] Spawn timeout — browser didn't send restore-session in 10s");
    spawnSession();
  }, 10_000);

  // --- Session snapshot helper ---
  // Reads all files from ~/.claude/projects/ and sends them to the browser.
  // Used by: periodic interval (30s backup), session file watcher (event-driven),
  // and request-snapshot handler (on-demand).
  const claudeProjectsDir = `${userHomeDir}/.claude/projects`;

  const sendSessionSnapshot = () => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      const { readdirSync, readFileSync, statSync } = require("fs");
      const files: Record<string, string> = {};

      const walkClaudeDir = (dir: string, prefix: string) => {
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const fullPath = `${dir}/${entry.name}`;
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              walkClaudeDir(fullPath, relPath);
            } else if (entry.isFile()) {
              try {
                const stat = statSync(fullPath);
                if (stat.size < 10 * 1024 * 1024) {
                  files[relPath] = readFileSync(fullPath, "utf-8");
                }
              } catch {}
            }
          }
        } catch {}
      };
      walkClaudeDir(claudeProjectsDir, "");

      if (Object.keys(files).length > 0) {
        ws.send(JSON.stringify({ type: "session-snapshot", files }));
      }
    } catch (err) {
      console.error("[ws] Session snapshot failed:", err);
    }
  };

  // --- Periodic snapshot (30s backup) ---
  const snapshotInterval = setInterval(sendSessionSnapshot, SESSION_SNAPSHOT_INTERVAL_MS);

  // --- Session file watcher (event-driven) ---
  // Watches ~/.claude/projects/ for changes. When Claude Code does a rewind,
  // clear, or compaction, it rewrites session files on disk. This watcher
  // detects those changes and sends an immediate snapshot to the browser
  // (debounced 2s so compaction — which writes many files — settles first).
  let sessionWatcher: import("chokidar").FSWatcher | null = null;
  let sessionSnapshotDebounce: NodeJS.Timeout | null = null;
  const SESSION_CHANGE_DEBOUNCE_MS = 2_000;

  const startSessionWatcher = async () => {
    try {
      const { mkdirSync: mkS } = require("fs");
      try { mkS(claudeProjectsDir, { recursive: true }); } catch {}

      const { watch } = await import("chokidar");
      sessionWatcher = watch(claudeProjectsDir, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });

      sessionWatcher.on("all", (event: string, filePath: string) => {
        // Debounce — compaction writes many files over several seconds.
        // We wait 2s after the LAST change to get a consistent snapshot.
        if (sessionSnapshotDebounce) clearTimeout(sessionSnapshotDebounce);
        sessionSnapshotDebounce = setTimeout(() => {
          console.log(`[session-watcher] Session files changed (${event}), sending snapshot`);
          sendSessionSnapshot();
        }, SESSION_CHANGE_DEBOUNCE_MS);
      });

      console.log(`[session-watcher] Watching ${claudeProjectsDir}`);
    } catch (err) {
      console.error("[session-watcher] Failed to start:", err);
    }
  };

  // --- Heartbeat ---
  let isAlive = true;
  let heartbeatTimeout: NodeJS.Timeout | null = null;

  const heartbeatInterval = setInterval(() => {
    if (!isAlive) {
      console.warn("[ws] Heartbeat timeout — closing connection");
      cleanup();
      ws.terminate();
      return;
    }
    isAlive = false;
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
      heartbeatTimeout = setTimeout(() => {
        if (!isAlive) {
          console.warn("[ws] Pong not received — closing");
          cleanup();
          ws.terminate();
        }
      }, HEARTBEAT_TIMEOUT_MS);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // --- Message handling ---

  ws.on("message", (raw: Buffer | string, isBinary: boolean) => {
    // Binary frames = terminal data (keystrokes)
    if (isBinary) {
      const s = (cleanup as any)._session;
      if (s) s.write(raw.toString());
      // Enter keypress (\r) = user submitted something — reset auto-continue
      // budget so the next max_tokens run starts fresh.
      if (raw.toString().includes("\r")) autoContinueCount = 0;
      return;
    }

    // JSON frames = control messages
    const text = raw.toString();
    let msg: {
      type: string;
      data?: string;
      cols?: number;
      rows?: number;
      path?: string;
      content?: string;
      files?: Record<string, string>;
    };

    try {
      msg = JSON.parse(text);
    } catch {
      console.warn("[ws] Invalid JSON message:", text.slice(0, 100));
      return;
    }

    switch (msg.type) {
      case "terminal":
        if (msg.data) {
          const s = (cleanup as any)._session;
          if (s) s.write(msg.data);
          if (msg.data.includes("\r")) autoContinueCount = 0;
        }
        break;

      case "resize":
        if (msg.cols && msg.rows) {
          const s = (cleanup as any)._session;
          if (s) s.resize(msg.cols, msg.rows);
        }
        break;

      case "file-write":
        if (msg.path && msg.content !== undefined) {
          handleFileWrite(projectDir, msg.path, msg.content);
        }
        break;

      case "file-write-binary":
        // Client sends base64-encoded bytes (e.g. image attachments) so
        // Claude Code's Read tool can load them as real local files.
        if (msg.path && typeof msg.content === "string") {
          handleFileWriteBinary(projectDir, msg.path, msg.content);
        }
        break;

      case "request-files":
        // Client's WebContainer booted — send all existing files for initial sync
        console.log("[ws] Client requested initial file sync");
        fileWatcher.sendAllFiles().catch((err: unknown) => {
          console.error("[ws] Failed to send initial files:", err);
        });
        break;

      case "restore-session":
        // If reusing workspace from grace period, session data is already
        // on disk and is MORE RECENT than what the browser has (e.g. after
        // compaction the browser snapshot is stale). Do NOT overwrite disk.
        if (reusingWorkspace) {
          console.log("[ws] Reusing workspace — session data on disk is authoritative, skipping browser restore");
        } else if (msg.files && typeof msg.files === "object") {
          const fileCount = Object.keys(msg.files).length;
          if (fileCount > 0) {
            const { mkdirSync: mkdirS, writeFileSync: writeS } = require("fs");
            try { mkdirS(claudeProjectsDir, { recursive: true }); } catch {}

            let restored = 0;
            for (const [relPath, content] of Object.entries(msg.files)) {
              if (typeof content !== "string") continue;
              const fullPath = `${claudeProjectsDir}/${relPath}`;
              const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
              try {
                mkdirS(dir, { recursive: true });
                writeS(fullPath, content, "utf-8");
                restored++;
              } catch {}
            }
            console.log(`[ws] Restored ${restored} session files`);
            if (restored > 0) hasExistingSession = true;
          }
        }
        // Now spawn Claude Code (it can see the restored session)
        clearTimeout(spawnTimeout);
        spawnSession();
        break;

      case "restore-files":
        // Browser downloaded project files from Supabase — write to workspace
        if (msg.files && typeof msg.files === "object") {
          const { mkdirSync: mkdirF, writeFileSync: writeF } = require("fs");
          let written = 0;
          for (const [filePath, content] of Object.entries(msg.files)) {
            if (typeof content !== "string") continue;
            const fullPath = `${projectDir}/${filePath}`;
            const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
            try {
              mkdirF(dir, { recursive: true });
              writeF(fullPath, content, "utf-8");
              written++;
            } catch {}
          }
          console.log(`[ws] Restored ${written} project files`);
        }
        break;

      case "pong":
        isAlive = true;
        if (heartbeatTimeout) {
          clearTimeout(heartbeatTimeout);
          heartbeatTimeout = null;
        }
        break;

      case "request-snapshot":
        // Browser wants a session snapshot NOW (before unload or periodic)
        sendSessionSnapshot();
        break;

      case "ping":
        // Client-initiated ping — respond immediately
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
        }
        isAlive = true;
        break;

      default:
        console.warn("[ws] Unknown message type:", msg.type);
    }
  });

  // --- Cleanup ---

  let cleanedUp = false;
  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;

    clearTimeout(spawnTimeout);
    clearInterval(snapshotInterval);
    clearInterval(heartbeatInterval);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);

    const sess = (cleanup as any)._session;
    if (sess) sess.kill();
    if (apiProxy) { apiProxy.stop(); apiProxy = null; }
    fileWatcher.stop();
    if (sessionWatcher) { sessionWatcher.close().catch(() => {}); sessionWatcher = null; }
    if (sessionSnapshotDebounce) { clearTimeout(sessionSnapshotDebounce); sessionSnapshotDebounce = null; }
    activeSessions.delete(ws);
    console.log(`[ws] Client disconnected (active: ${activeSessions.size})`);

    // --- Deferred cleanup with grace period ---
    // Don't wipe workspace immediately. Start a 30s timer. If the same
    // projectId reconnects within that window, cancel the wipe and reuse
    // the existing session data on disk (so --continue just works).
    if (cleanupKey) {
      // Save to Supabase in the background (non-blocking)
      const pendingEntry: PendingCleanup = {
        timer: null as unknown as NodeJS.Timeout,
        projectDir,
        userHomeDir,
        userId: userId || "",
        savedToSupabase: false,
      };

      // Start Supabase save immediately (runs during the grace period)
      const supabaseSavePromise = saveToSupabase(projectDir, userHomeDir, userId || "", projectId || "")
        .then(() => { pendingEntry.savedToSupabase = true; })
        .catch(() => {});

      // Set the wipe timer
      pendingEntry.timer = setTimeout(async () => {
        pendingCleanups.delete(cleanupKey);
        // Ensure Supabase save finished before wiping
        await supabaseSavePromise;
        wipeWorkspace(projectDir, userHomeDir);
      }, RECONNECT_GRACE_MS);

      pendingCleanups.set(cleanupKey, pendingEntry);
      console.log(`[ws] Grace period started for ${cleanupKey} (${RECONNECT_GRACE_MS / 1000}s)`);
    } else {
      // No projectId — wipe immediately (anonymous session)
      await saveToSupabase(projectDir, userHomeDir, userId || "", projectId || "");
      wipeWorkspace(projectDir, userHomeDir);
    }
  }

  ws.on("close", () => cleanup());
  ws.on("error", (err) => {
    console.error("[ws] WebSocket error:", err);
    cleanup();
  });
});

// --- Helper: Save session + files to Supabase ---

async function saveToSupabase(
  projectDir: string,
  userHomeDir: string,
  userId: string,
  projectId: string,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId || !projectId) return;
  const { readdirSync, readFileSync, statSync } = require("fs");

  // 1. Save session data (Claude Code transcripts)
  try {
    const claudeProjectsDir = `${userHomeDir}/.claude/projects`;
    const sessionFiles: Record<string, string> = {};
    const walkDir = (dir: string, prefix: string) => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const fp = `${dir}/${entry.name}`;
          const rp = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walkDir(fp, rp);
          else if (entry.isFile() && statSync(fp).size < 10 * 1024 * 1024) {
            sessionFiles[rp] = readFileSync(fp, "utf-8");
          }
        }
      } catch {}
    };
    walkDir(claudeProjectsDir, "");

    if (Object.keys(sessionFiles).length > 0) {
      const sessionBody = JSON.stringify({ files: sessionFiles });
      const storagePath = `${userId}/${projectId}/session.json`;
      const res = await fetch(
        `${SUPABASE_URL}/storage/v1/object/claude-sessions/${storagePath}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json",
            apikey: SUPABASE_SERVICE_KEY,
          },
          body: sessionBody,
        }
      );
      if (res.ok) {
        console.log(`[ws] Saved session to Supabase (${Object.keys(sessionFiles).length} files)`);
      } else {
        // Try POST (create) if PUT (update) failed
        const res2 = await fetch(
          `${SUPABASE_URL}/storage/v1/object/claude-sessions/${storagePath}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
              "Content-Type": "application/json",
              apikey: SUPABASE_SERVICE_KEY,
            },
            body: sessionBody,
          }
        );
        if (res2.ok) {
          console.log(`[ws] Saved session to Supabase (created new)`);
        } else {
          console.error(`[ws] Failed to save session: ${res2.status}`);
        }
      }
    }
  } catch (err) {
    console.error("[ws] Session save failed:", err);
  }

  // 2. Save project files
  try {
    const pathMod = require("path");
    const crypto = require("crypto");
    const files: Array<{ path: string; content: string }> = [];
    const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build"]);

    const walkWorkspace = (dir: string) => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (SKIP.has(entry.name)) continue;
          const fp = pathMod.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkWorkspace(fp);
          } else if (entry.isFile()) {
            try {
              const stat = statSync(fp);
              if (stat.size < 10 * 1024 * 1024) {
                const content = readFileSync(fp, "utf-8");
                const relPath = pathMod.relative(projectDir, fp);
                files.push({ path: relPath, content });
              }
            } catch {}
          }
        }
      } catch {}
    };
    walkWorkspace(projectDir);

    if (files.length > 0) {
      const upsertRows = files.map((f) => ({
        project_id: projectId,
        path: f.path,
        content: f.content,
        content_hash: crypto.createHash("sha256").update(f.content).digest("hex"),
        size_bytes: Buffer.byteLength(f.content, "utf-8"),
      }));

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/project_files?on_conflict=project_id,path`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json",
            apikey: SUPABASE_SERVICE_KEY,
            Prefer: "resolution=merge-duplicates",
          },
          body: JSON.stringify(upsertRows),
        }
      );
      console.log(`[ws] Saved ${files.length} files to Supabase (status: ${res.status})`);
    }
  } catch (err) {
    console.error("[ws] File save failed:", err);
  }
}

// --- Helper: Wipe workspace + user home ---

function wipeWorkspace(projectDir: string, userHomeDir: string): void {
  const { rmSync } = require("fs");
  try {
    rmSync(projectDir, { recursive: true, force: true });
    console.log(`[ws] Cleaned workspace: ${projectDir}`);
  } catch (err: unknown) {
    console.error("[ws] Workspace cleanup failed:", err);
  }
  try {
    rmSync(userHomeDir, { recursive: true, force: true });
    console.log(`[ws] Cleaned user home: ${userHomeDir}`);
  } catch (err: unknown) {
    console.error("[ws] User home cleanup failed:", err);
  }
}

// --- Start server ---

server.listen(PORT, () => {
  console.log(`[relay-server] Listening on port ${PORT}`);
  console.log(`[relay-server] Workspace: ${WORKSPACE_DIR}`);
  console.log(`[relay-server] Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[relay-server] SIGTERM received, shutting down...");
  wss.clients.forEach((ws) => {
    ws.close(1001, "Server shutting down");
  });
  server.close(() => {
    console.log("[relay-server] Server closed");
    process.exit(0);
  });
});
