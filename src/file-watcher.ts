/**
 * File watcher — watches /workspace recursively via chokidar,
 * pushes file changes over WebSocket to the browser.
 */

import * as fs from "fs";
import * as path from "path";
import type { FSWatcher } from "chokidar";
import type { WebSocket } from "ws";

export type FileChangeEvent = "add" | "change" | "unlink";

export interface FileChangeMessage {
  type: "file-change";
  path: string;
  content: string;
  event: FileChangeEvent;
}

const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
];

const DEBOUNCE_MS = 200;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private workspaceDir: string;
  private ws: WebSocket;

  constructor(ws: WebSocket, workspaceDir: string) {
    this.ws = ws;
    this.workspaceDir = workspaceDir;
  }

  async start(): Promise<void> {
    // Dynamic import since chokidar v4 is ESM
    const { watch } = await import("chokidar");

    this.watcher = watch(this.workspaceDir, {
      ignored: IGNORE_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: DEBOUNCE_MS,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (filePath) => this.handleChange(filePath, "add"));
    this.watcher.on("change", (filePath) => this.handleChange(filePath, "change"));
    this.watcher.on("unlink", (filePath) => this.handleChange(filePath, "unlink"));
    this.watcher.on("error", (err) => {
      console.error("[file-watcher] Error:", err);
    });

    console.log(`[file-watcher] Watching ${this.workspaceDir}`);
  }

  private handleChange(filePath: string, event: FileChangeEvent): void {
    // Debounce rapid changes to the same file
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.sendChange(filePath, event);
    }, DEBOUNCE_MS);

    this.debounceTimers.set(filePath, timer);
  }

  private sendChange(filePath: string, event: FileChangeEvent): void {
    if (this.ws.readyState !== this.ws.OPEN) return;

    const relativePath = path.relative(this.workspaceDir, filePath);
    let content = "";

    if (event !== "unlink") {
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        // File may have been deleted between event and read
        return;
      }
    }

    const message: FileChangeMessage = {
      type: "file-change",
      path: relativePath,
      content,
      event,
    };

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Send all existing files in the workspace to the browser.
   * Called when the client sends "request-files" after WebContainer boots.
   */
  async sendAllFiles(): Promise<void> {
    if (this.ws.readyState !== this.ws.OPEN) return;
    console.log(`[file-watcher] Sending all files from ${this.workspaceDir}`);
    await this.walkAndSend(this.workspaceDir);
    console.log("[file-watcher] Initial file sync complete");
  }

  private async walkAndSend(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip ignored directories
      if (
        entry.isDirectory() &&
        (entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === ".next" ||
          entry.name === "dist" ||
          entry.name === "build")
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.walkAndSend(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const relativePath = path.relative(this.workspaceDir, fullPath);
          const message: FileChangeMessage = {
            type: "file-change",
            path: relativePath,
            content,
            event: "add",
          };
          this.ws.send(JSON.stringify(message));
        } catch {
          // Skip unreadable files (binary, permission errors, etc.)
        }
      }
    }
  }

  async stop(): Promise<void> {
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    console.log("[file-watcher] Stopped");
  }
}

/**
 * Resolve a browser-supplied relative path to an absolute path inside the
 * workspace, rejecting anything that would escape. Shared by the text and
 * binary write handlers so the traversal guard lives in exactly one place.
 */
function resolveWorkspacePath(
  workspaceDir: string,
  filePath: string,
): string | null {
  const fullPath = path.resolve(workspaceDir, filePath);
  const workspaceRoot = path.resolve(workspaceDir);
  // path.resolve strips trailing separators, so the prefix check must allow
  // an exact match AND a match followed by a separator — otherwise a sibling
  // directory with a prefix name (e.g. /workspace-evil vs /workspace) would
  // slip through.
  if (
    fullPath !== workspaceRoot &&
    !fullPath.startsWith(workspaceRoot + path.sep)
  ) {
    return null;
  }
  return fullPath;
}

/**
 * Handle a file-write message from the browser — write to VM filesystem.
 */
export function handleFileWrite(
  workspaceDir: string,
  filePath: string,
  content: string
): void {
  const fullPath = resolveWorkspacePath(workspaceDir, filePath);
  if (!fullPath) {
    console.error(`[file-write] Path traversal attempt blocked: ${filePath}`);
    return;
  }

  // Create parent directories if needed
  const dir = path.dirname(fullPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err: unknown) {
    // Skip if already exists as a directory (EEXIST)
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      console.error(`[file-write] Failed to create dir ${dir}:`, err);
      return;
    }
  }

  // Don't write if target path is a directory
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      console.warn(`[file-write] Skipping — path is a directory: ${filePath}`);
      return;
    }
  } catch {
    // File doesn't exist yet — that's fine, we'll create it
  }

  try {
    fs.writeFileSync(fullPath, content, "utf-8");
    console.log(`[file-write] ${filePath}`);
  } catch (err) {
    console.error(`[file-write] Failed to write ${filePath}:`, err);
  }
}

/**
 * Handle a file-write-binary message from the browser — decode base64 and
 * write raw bytes to the VM filesystem.
 *
 * Used for image attachments so Claude Code's Read tool (which only loads
 * local files, not URLs) can hand real image bytes to the vision model.
 */
export function handleFileWriteBinary(
  workspaceDir: string,
  filePath: string,
  base64Content: string,
): void {
  const fullPath = resolveWorkspacePath(workspaceDir, filePath);
  if (!fullPath) {
    console.error(
      `[file-write-binary] Path traversal attempt blocked: ${filePath}`,
    );
    return;
  }

  const dir = path.dirname(fullPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      console.error(`[file-write-binary] Failed to create dir ${dir}:`, err);
      return;
    }
  }

  // Don't overwrite a directory with a file
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      console.warn(
        `[file-write-binary] Skipping — path is a directory: ${filePath}`,
      );
      return;
    }
  } catch {
    // not existing is fine
  }

  try {
    const buffer = Buffer.from(base64Content, "base64");
    fs.writeFileSync(fullPath, buffer);
    console.log(
      `[file-write-binary] ${filePath} (${buffer.byteLength} bytes)`,
    );
  } catch (err) {
    console.error(`[file-write-binary] Failed to write ${filePath}:`, err);
  }
}
