import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import type { MonitorConfig, WorkspaceConfig } from "./config.js";

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "build",
  "dist",
  ".cache",
  "coverage",
  ".next",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

interface WalkResult {
  signatures: Map<string, number>; // relpath -> mtimeMs
  truncated: boolean;
}

export async function walkWorkspace(
  root: string,
  maxFiles: number,
): Promise<WalkResult> {
  const signatures = new Map<string, number>();
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        if (signatures.size >= maxFiles) {
          truncated = true;
          return;
        }
        const full = join(dir, entry.name);
        try {
          const stat = await fs.stat(full);
          signatures.set(relative(root, full), stat.mtimeMs);
        } catch {
          // vanished mid-scan
        }
      }
      if (truncated) return;
    }
  }

  await walk(root);
  return { signatures, truncated };
}

export interface WorkspaceDelta {
  changedFiles: number;
  changedPaths: string[];
}

export async function observeWorkspace(
  workspace: WorkspaceConfig,
  state: { signatures: Map<string, number> | null },
): Promise<WorkspaceDelta> {
  const { signatures } = await walkWorkspace(workspace.path, 5000);
  const delta: WorkspaceDelta = { changedFiles: 0, changedPaths: [] };
  if (state.signatures) {
    for (const [path, mtime] of signatures) {
      const previous = state.signatures.get(path);
      if (previous === undefined || previous !== mtime) {
        delta.changedFiles += 1;
        delta.changedPaths.push(path);
      }
    }
  }
  state.signatures = signatures;
  return delta;
}

export interface GitSummary {
  branch: string | null;
  dirtyFiles: number;
  insertions: number;
  deletions: number;
}

/** Read-only git observation. Never mutates the repository. */
export async function observeGit(workspacePath: string): Promise<GitSummary | null> {
  try {
    const { stdout: statusOut } = await execFileAsync(
      "git",
      ["-C", workspacePath, "status", "--porcelain=v1", "--branch", "--ignored=no"],
      { timeout: 10000 },
    );
    const lines = statusOut.split("\n").filter(Boolean);
    const branchLine = lines[0]?.startsWith("## ") ? lines[0] : null;
    const branch = branchLine
      ? branchLine.replace("## ", "").split(/\s/)[0]?.replace(/^\.\.\./, "") ?? null
      : null;
    const dirty = branchLine ? lines.slice(1) : lines;
    let insertions = 0;
    let deletions = 0;
    try {
      const { stdout: shortstat } = await execFileAsync(
        "git",
        ["-C", workspacePath, "diff", "--shortstat", "HEAD", "--ignore-submodules=all"],
        { timeout: 15000 },
      );
      insertions = Number(shortstat.match(/(\d+) insertion/)?.[1] ?? 0);
      deletions = Number(shortstat.match(/(\d+) deletion/)?.[1] ?? 0);
    } catch {
      // empty repo or no HEAD: counts stay 0
    }
    return { branch, dirtyFiles: dirty.length, insertions, deletions };
  } catch {
    return null;
  }
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

export function matchArtifacts(paths: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const res: string[] = [];
  for (const path of paths) {
    if (patterns.some((pattern) => globToRegExp(pattern).test(path))) {
      res.push(basename(path));
    }
  }
  return res;
}

export interface TranscriptStat {
  mtimeMs: number;
  size: number;
  path: string;
}

/** Codex rollout files live in <transcriptDir>/YYYY/MM/DD/rollout-*-<uuid>.jsonl */
export async function scanTranscriptDir(
  transcriptDir: string,
): Promise<Map<string, TranscriptStat>> {
  const out = new Map<string, TranscriptStat>();
  const readDirs = async (dir: string): Promise<string[]> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  };
  const dayPaths: string[] = [];
  for (const year of (await readDirs(transcriptDir)).slice(-2)) {
    for (const month of (await readDirs(join(transcriptDir, year))).slice(-2)) {
      for (const day of (await readDirs(join(transcriptDir, year, month))).slice(-3)) {
        dayPaths.push(join(transcriptDir, year, month, day));
      }
    }
  }
  dayPaths.sort();
  for (const day of dayPaths.slice(-3)) {
    let files: string[] = [];
    try {
      files = await fs.readdir(day);
    } catch {
      continue;
    }
    for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
      const full = join(day, file);
      try {
        const stat = await fs.stat(full);
        const uuid = basename(file, ".jsonl").match(
          /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
        )?.[1];
        if (uuid) out.set(uuid, { mtimeMs: stat.mtimeMs, size: stat.size, path: full });
      } catch {
        // ignore
      }
    }
  }
  return out;
}

/**
 * Qoder sessions live in <qoderDir>/<project-slug>/<session-id>.jsonl. Keyed by
 * file stem because that is the hook payload's session_id; unlike the host
 * bridge we only ever look up sessions we already know, so extra JSONL files in
 * a project directory cannot invent phantom sessions.
 */
export async function scanQoderProjects(
  qoderDir: string,
): Promise<Map<string, TranscriptStat>> {
  const out = new Map<string, TranscriptStat>();
  let projects: string[] = [];
  try {
    const entries = await fs.readdir(qoderDir, { withFileTypes: true });
    projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const project of projects) {
    let files: string[] = [];
    try {
      files = await fs.readdir(join(qoderDir, project));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = join(qoderDir, project, file);
      try {
        const stat = await fs.stat(full);
        out.set(basename(file, ".jsonl"), {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          path: full,
        });
      } catch {
        // ignore
      }
    }
  }
  return out;
}

/**
 * Positive evidence about whether a session still has work in flight, read from
 * its transcript. Absence of writes proves nothing — a session that ended
 * cleanly and a session that hung forever both stop appending — so the state
 * machine needs something stronger than a clock to retire a session quietly.
 */
export type TurnEvidence = "in_flight" | "idle";

const TAIL_READ_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify the last *message* record of a transcript, walked from the end.
 * Bookkeeping records (`active-leaf`, `last-prompt`, `workspace-directories`,
 * `runtime-config`, `attachment`, ...) are appended after the turn is over and
 * say nothing about it, so they are skipped, as are unparseable lines. Returns
 * null when the file holds no message we can read — an unknown format must
 * never suppress a notification.
 */
export function classifyTranscriptTail(lines: string[]): TurnEvidence | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // torn or over-long record: not evidence either way
    }
    if (!isRecord(record) || !isRecord(record.message)) continue;
    const message = record.message;
    if (record.type === "assistant") {
      return message.stop_reason === "end_turn" ? "idle" : "in_flight";
    }
    if (record.type !== "user") continue;
    // An interrupt marker is the transcript's own word for "the user stopped
    // this": no turn is coming back. A bare prompt or a tool result means the
    // answer never arrived, which is exactly what a stall looks like.
    return wasInterrupted(message) ? "idle" : "in_flight";
  }
  return null;
}

function wasInterrupted(message: Record<string, unknown>): boolean {
  const parts = Array.isArray(message.content) ? message.content : [message.content];
  return parts.some(
    (part) =>
      typeof part === "string"
        ? INTERRUPTED_MARKER.test(part.trim())
        : isRecord(part) &&
          part.type === "text" &&
          INTERRUPTED_MARKER.test(String(part.text ?? "").trim()),
  );
}

const INTERRUPTED_MARKER = /^\[Request interrupted by user/;

/** Tail-only read: transcripts reach hundreds of MB and only their end matters. */
export async function transcriptTurnEvidence(
  path: string,
  maxBytes = TAIL_READ_BYTES,
): Promise<TurnEvidence | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(path, "r");
    const { size } = await handle.stat();
    if (size === 0) return null;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // window began mid-line; that fragment is unreadable
    return classifyTranscriptTail(lines);
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      // already closed
    }
  }
}
