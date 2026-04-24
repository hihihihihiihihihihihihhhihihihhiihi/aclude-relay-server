/**
 * PTY session manager — spawns Claude Code in a pseudo-terminal
 * and pipes I/O between the PTY and a WebSocket connection.
 */

import type { WebSocket } from "ws";
import type { IPty } from "node-pty";
import { writeFileSync } from "fs";
import { join } from "path";
import { SYSTEM_PROMPT } from "./system-prompt";

export interface SessionOptions {
  cols: number;
  rows: number;
  workspaceDir: string;
  apiKey?: string;
  sessionId?: string;
  hasExistingSession?: boolean; // true if session data was restored from Supabase
  env?: Record<string, string>;
  proxyPort?: number;  // port of the local API proxy
}

export class Session {
  private pty: IPty | null = null;
  private ws: WebSocket;
  private options: SessionOptions;

  constructor(ws: WebSocket, options: SessionOptions) {
    this.ws = ws;
    this.options = options;
  }

  async spawn(): Promise<void> {
    return this.spawnInternal(this.options.hasExistingSession === true);
  }

  /**
   * Spawn Claude Code in the PTY.
   *
   * If `withContinue` is true, passes `--continue` so Claude Code resumes
   * the most recent conversation for this cwd. If that fails (Claude Code
   * can't find a matching conversation — common when session files were
   * restored from Supabase but don't match the new cwd), we catch the
   * early exit-code-1 and automatically retry WITHOUT `--continue`. This
   * is the critical fix for the "No conversation found to continue →
   * Claude Code exited (code 1) → ws 1005 close → client cascades through
   * every backend → all_down" failure mode.
   *
   * Retry happens in-place on the same WebSocket, so the client sees no
   * disconnect — just a slight delay before the "ready" message.
   */
  private async spawnInternal(withContinue: boolean): Promise<void> {
    // node-pty is a native module — require at runtime
    const nodePty = require("node-pty") as typeof import("node-pty");

    const env: Record<string, string> = {
      TERM: "xterm-256color",
      HOME: process.env.HOME || "/home/node",
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      // Disable auto-update check — prevents "Auto-update failed" message
      CLAUDE_CODE_SKIP_UPDATE_CHECK: "1",
      DISABLE_AUTOUPDATER: "1",
      ...this.options.env,
    };

    // Route Claude Code's API traffic through the local proxy for SSE interception
    if (this.options.proxyPort) {
      env.ANTHROPIC_BASE_URL = `http://localhost:${this.options.proxyPort}`;
    }

    // OAuth tokens (sk-ant-oat01-*) go via CLAUDE_CODE_OAUTH_TOKEN env var —
    // this is the official Claude Code env var for OAuth auth and works
    // silently without any interactive prompt. Writing `primaryApiKey` in
    // .claude.json is for REAL API keys (sk-ant-api03-*), not OAuth tokens,
    // which is why the old approach was producing intermittent "Not logged
    // in · Please run /login" errors.
    //
    // DO NOT pass ANTHROPIC_API_KEY as env var for real API keys — Claude
    // Code detects it and shows an interactive "use this key?" prompt that
    // blocks startup. API keys still go through .claude.json.
    if (this.options.apiKey && this.options.apiKey.startsWith("sk-ant-oat")) {
      env.CLAUDE_CODE_OAUTH_TOKEN = this.options.apiKey;
    }

    // --dangerously-skip-permissions: auto-approve all tool calls (write/edit
    // file, bash, etc.) so Claude Code never blocks the PTY on an interactive
    // "Do you want to create index.html?" prompt. Without this flag, every
    // fresh spawn reverts to the default ask-per-tool mode — the setting the
    // user picked via /permissions in a prior run does NOT persist across
    // new PTYs. We've already scoped HOME per user+project, so the blast
    // radius of auto-approval is confined to the user's own workspace.
    // Write the Aclude system prompt to a file in the workspace so we can
    // pass it via --system-prompt-file. This REPLACES Claude Code's default
    // system prompt with the Aclude identity + coding rules.
    const promptPath = join(this.options.workspaceDir, ".aclude-system-prompt.md");
    writeFileSync(promptPath, SYSTEM_PROMPT, "utf-8");

    const args: string[] = [
      "--dangerously-skip-permissions",
      "--model", "claude-opus-4-7",
      "--system-prompt-file", promptPath,
    ];
    if (withContinue) args.push("--continue");

    const spawnedAt = Date.now();

    this.pty = nodePty.spawn("claude", args, {
      name: "xterm-256color",
      cols: this.options.cols,
      rows: this.options.rows,
      cwd: this.options.workspaceDir,
      env,
    });

    // Buffer PTY output so we can scan it for the "No conversation found"
    // error. We can't retry based on stdout alone (Claude Code prints many
    // messages), so we only retry on early exit-code-1 below — the stdout
    // check is an extra signal for logging/debugging.
    let sawNoConversationError = false;

    this.pty.onData((data: string) => {
      if (withContinue && !sawNoConversationError && data.includes("No conversation found to continue")) {
        sawNoConversationError = true;
      }
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ type: "terminal", data }));
      }
    });

    this.pty.onExit(({ exitCode }) => {
      const elapsedMs = Date.now() - spawnedAt;
      console.log(
        `[session] Claude Code exited (code ${exitCode}, after ${elapsedMs}ms, withContinue=${withContinue}, sawNoConv=${sawNoConversationError})`,
      );

      // Auto-retry fix: if --continue failed fast with exit 1 (either the
      // "No conversation found" message or a silent early exit), respawn
      // without --continue. Don't close the WebSocket — the client stays
      // connected and sees the fresh Claude Code come up in a moment.
      const shouldRetryFresh =
        withContinue &&
        exitCode === 1 &&
        elapsedMs < 5000 &&
        this.ws.readyState === this.ws.OPEN;

      if (shouldRetryFresh) {
        console.log(
          "[session] Retrying spawn without --continue (fresh session)",
        );
        // Clear the old pty reference; spawnInternal will set a new one
        this.pty = null;
        // Fire-and-forget retry. Errors inside spawnInternal will close
        // the ws via the normal path below on the nested retry.
        this.spawnInternal(false).catch((err) => {
          console.error("[session] Retry spawn failed:", err);
          if (this.ws.readyState === this.ws.OPEN) {
            this.ws.send(
              JSON.stringify({ type: "exit", code: exitCode }),
            );
            this.ws.close();
          }
        });
        return;
      }

      // Normal exit path — notify client and close.
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        this.ws.close();
      }
    });

    // Notify client that Claude Code is ready. Only on the first spawn —
    // the retry path keeps the same ws and doesn't need another "ready".
    if (withContinue === (this.options.hasExistingSession === true)) {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ type: "ready" }));
      }
    }

    console.log(
      `[session] Spawned Claude Code (pid: ${this.pty.pid}, cwd: ${this.options.workspaceDir}, --continue=${withContinue})`,
    );
  }

  /** Write terminal input from the browser to the PTY. */
  write(data: string): void {
    if (this.pty) {
      this.pty.write(data);
    }
  }

  /** Resize the PTY to match the browser terminal dimensions. */
  resize(cols: number, rows: number): void {
    if (this.pty) {
      this.pty.resize(cols, rows);
      console.log(`[session] Resized to ${cols}x${rows}`);
    }
  }

  /** Kill the PTY process and clean up. */
  kill(): void {
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        // Already dead
      }
      this.pty = null;
      console.log("[session] Killed PTY");
    }
  }

  get pid(): number | undefined {
    return this.pty?.pid;
  }
}
