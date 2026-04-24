/**
 * Supabase Sync — downloads/uploads project files and Claude Code session data
 * between the VM workspace and the Aclude platform (via HTTP API).
 *
 * The relay server runs on the VM, NOT inside Next.js, so we call the
 * Aclude API endpoints over HTTP rather than importing Supabase directly.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface SyncConfig {
  /** Base URL of the Aclude API (e.g. "https://aclude.com" or "http://localhost:3000") */
  apiBaseUrl: string;
  /** Auth token passed to API requests */
  authToken?: string;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".cache",
]);

export class SupabaseSync {
  private config: SyncConfig;

  constructor(config: SyncConfig) {
    this.config = config;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.authToken) {
      h["Authorization"] = `Bearer ${this.config.authToken}`;
    }
    return h;
  }

  // ─── Download ───────────────────────────────────────────────

  /**
   * Fetch all project files from Supabase via the Aclude API
   * and write them to the workspace directory.
   */
  async downloadProjectFiles(
    projectId: string,
    workspaceDir: string
  ): Promise<number> {
    console.log(`[supabase-sync] Downloading project files for ${projectId}`);

    const res = await fetch(
      `${this.config.apiBaseUrl}/api/projects/${projectId}/files`,
      { headers: this.headers() }
    );

    if (!res.ok) {
      throw new Error(
        `Failed to fetch project files: ${res.status} ${res.statusText}`
      );
    }

    const data = await res.json() as Record<string, unknown>;
    const files: Array<{ path: string; content: string; size_bytes?: number }> =
      Array.isArray(data) ? data : ((data as Record<string, unknown>).files as Array<{ path: string; content: string; size_bytes?: number }>) ?? [];

    let written = 0;
    for (const file of files) {
      if (!file.path || file.content === undefined) continue;
      if (file.size_bytes && file.size_bytes > MAX_FILE_SIZE) {
        console.log(`[supabase-sync] Skipping large file: ${file.path}`);
        continue;
      }

      const fullPath = path.join(workspaceDir, file.path);

      // Security: ensure resolved path stays within workspace
      if (!path.resolve(fullPath).startsWith(path.resolve(workspaceDir))) {
        console.warn(
          `[supabase-sync] Path traversal blocked: ${file.path}`
        );
        continue;
      }

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content, "utf-8");
      written++;
    }

    console.log(
      `[supabase-sync] Downloaded ${written}/${files.length} files to ${workspaceDir}`
    );
    return written;
  }

  /**
   * Fetch Claude Code session data from the claude-sessions bucket
   * and restore it to the user's .claude directory.
   */
  async downloadSessionData(
    userId: string,
    projectId: string,
    claudeHomeDir: string
  ): Promise<void> {
    console.log(
      `[supabase-sync] Downloading session data for user=${userId} project=${projectId}`
    );

    const res = await fetch(
      `${this.config.apiBaseUrl}/api/projects/${projectId}/session`,
      { headers: this.headers() }
    );

    if (!res.ok) {
      if (res.status === 404) {
        console.log("[supabase-sync] No existing session data found");
        return;
      }
      throw new Error(
        `Failed to fetch session data: ${res.status} ${res.statusText}`
      );
    }

    const session = (await res.json()) as { files?: Record<string, string> };
    if (!session.files || Object.keys(session.files).length === 0) {
      console.log("[supabase-sync] Session data is empty");
      return;
    }

    // Claude Code stores sessions under ~/.claude/projects/{hash}/
    // The session JSON maps relative paths to content within that structure.
    const claudeDir = path.join(claudeHomeDir, ".claude", "projects");
    fs.mkdirSync(claudeDir, { recursive: true });

    let restored = 0;
    for (const [relPath, content] of Object.entries(session.files)) {
      const fullPath = path.join(claudeDir, relPath);

      if (!path.resolve(fullPath).startsWith(path.resolve(claudeDir))) {
        console.warn(
          `[supabase-sync] Session path traversal blocked: ${relPath}`
        );
        continue;
      }

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
      restored++;
    }

    console.log(
      `[supabase-sync] Restored ${restored} session files to ${claudeDir}`
    );
  }

  // ─── Upload ─────────────────────────────────────────────────

  /**
   * Read workspace files, compute SHA-256 hashes, and upload only
   * changed files to the Aclude API.
   */
  async uploadProjectFiles(
    projectId: string,
    workspaceDir: string
  ): Promise<number> {
    if (!fs.existsSync(workspaceDir)) {
      console.log("[supabase-sync] Workspace dir does not exist, skipping upload");
      return 0;
    }

    // Collect local files
    const localFiles = this.walkDir(workspaceDir, workspaceDir);

    if (localFiles.length === 0) {
      console.log("[supabase-sync] No files to upload");
      return 0;
    }

    // Fetch existing hashes from the server for delta comparison
    let existingHashes: Record<string, string> = {};
    try {
      const res = await fetch(
        `${this.config.apiBaseUrl}/api/projects/${projectId}/files`,
        { headers: this.headers() }
      );
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        const files: Array<{ path: string; content_hash?: string }> =
          Array.isArray(data) ? data : ((data as Record<string, unknown>).files as Array<{ path: string; content_hash?: string }>) ?? [];
        for (const f of files) {
          if (f.path && f.content_hash) {
            existingHashes[f.path] = f.content_hash;
          }
        }
      }
    } catch {
      // If we can't fetch existing hashes, upload everything
      console.warn("[supabase-sync] Could not fetch existing hashes, uploading all");
    }

    // Filter to only changed files
    const changedFiles: Array<{
      path: string;
      content: string;
      content_hash: string;
    }> = [];

    for (const file of localFiles) {
      if (file.content_hash !== existingHashes[file.path]) {
        changedFiles.push(file);
      }
    }

    if (changedFiles.length === 0) {
      console.log("[supabase-sync] No files changed, skipping upload");
      return 0;
    }

    console.log(
      `[supabase-sync] Uploading ${changedFiles.length} changed files (${localFiles.length} total)`
    );

    // Batch upload via POST /api/projects/{id}/files
    const res = await fetch(
      `${this.config.apiBaseUrl}/api/projects/${projectId}/files`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ files: changedFiles }),
      }
    );

    if (!res.ok) {
      throw new Error(
        `Failed to upload project files: ${res.status} ${res.statusText}`
      );
    }

    console.log(`[supabase-sync] Uploaded ${changedFiles.length} files`);
    return changedFiles.length;
  }

  /**
   * Read Claude Code session files and upload to the claude-sessions bucket.
   */
  async uploadSessionData(
    userId: string,
    projectId: string,
    claudeHomeDir: string
  ): Promise<void> {
    const claudeProjectsDir = path.join(claudeHomeDir, ".claude", "projects");

    if (!fs.existsSync(claudeProjectsDir)) {
      console.log("[supabase-sync] No Claude session data to upload");
      return;
    }

    // Collect all session files into a flat map: relativePath -> content
    const sessionFiles: Record<string, string> = {};
    const allFiles = this.walkDir(claudeProjectsDir, claudeProjectsDir, false);

    for (const f of allFiles) {
      sessionFiles[f.path] = f.content;
    }

    if (Object.keys(sessionFiles).length === 0) {
      console.log("[supabase-sync] No session files found");
      return;
    }

    console.log(
      `[supabase-sync] Uploading ${Object.keys(sessionFiles).length} session files`
    );

    const res = await fetch(
      `${this.config.apiBaseUrl}/api/projects/${projectId}/session`,
      {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({ files: sessionFiles }),
      }
    );

    if (!res.ok) {
      throw new Error(
        `Failed to upload session data: ${res.status} ${res.statusText}`
      );
    }

    console.log("[supabase-sync] Session data uploaded");
  }

  // ─── Cleanup ────────────────────────────────────────────────

  /**
   * Remove the workspace directory after final sync.
   */
  cleanupWorkspace(workspaceDir: string): void {
    if (!fs.existsSync(workspaceDir)) return;

    console.log(`[supabase-sync] Cleaning up workspace: ${workspaceDir}`);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    console.log("[supabase-sync] Workspace cleaned up");
  }

  // ─── Helpers ────────────────────────────────────────────────

  /**
   * Recursively walk a directory and return file metadata + content.
   * Skips ignored dirs, binary files, and files > MAX_FILE_SIZE.
   */
  private walkDir(
    dir: string,
    rootDir: string,
    skipIgnored: boolean = true
  ): Array<{ path: string; content: string; content_hash: string }> {
    const results: Array<{
      path: string;
      content: string;
      content_hash: string;
    }> = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (skipIgnored && IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        results.push(...this.walkDir(fullPath, rootDir, skipIgnored));
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;

          const content = fs.readFileSync(fullPath, "utf-8");
          const contentHash = crypto
            .createHash("sha256")
            .update(content)
            .digest("hex");
          const relativePath = path.relative(rootDir, fullPath);

          results.push({
            path: relativePath,
            content,
            content_hash: contentHash,
          });
        } catch {
          // Skip files we can't read (binary, permissions, etc.)
        }
      }
    }

    return results;
  }
}
