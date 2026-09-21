// herald-host: thin macOS Host Bridge for Herald.
// Facts only — no policy. Runs on the host (outside Docker), POSTs to the
// loopback-published container API. Responsibilities:
//   1. host heartbeat            -> POST /host-heartbeat
//   2. sleep/wake gap detection  -> sleep_gap_seconds on observations
//   3. session activity facts    -> POST /observations (transcripts + agent processes)
// Config: ~/.config/agent-notify/host.json
//   { "serverUrl": "http://127.0.0.1:8787", "token": "<token>",
//     "codexSessionsDir": "~/.codex/sessions", "intervalSeconds": 30 }

import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BRIDGE_VERSION = "0.1.0";
const DEFAULT_INTERVAL_SECONDS = 30;
// Executable basename marks a possibly-working agent (node|npx wrapper allowed
// as argv[0] with the agent as argv[1]). Path substrings must NOT match.
const AGENT_EXES = new Set(["codex", "claude", "opencode", "qoder"]);
const RUNTIME_EXES = new Set(["node", "deno", "bun", "npx"]);
// Resident daemons / GUI helpers are NOT per-session work: an always-on
// app-server or framework helper would make every session look ACTIVE forever.
const RESIDENT_MARKERS = [
  "app-server",
  ".framework/",
  " Helper",
  "code-mode-host",
  "Updater.app",
  // Qoder desktop is a GUI app that lives for hours; only its CLI counts.
  "/Qoder.app/Contents/MacOS/Qoder",
];
// Transcript file touched within this window means its session is alive.
const TRANSCRIPT_ACTIVE_WINDOW_MS = 120_000;

function expandHome(value) {
  if (value === "~" || value.startsWith("~/")) {
    return join(homedir(), value.slice(2) || ".");
  }
  return value;
}

export function parseHostConfig(raw) {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("host config must be an object");
  }
  if (typeof raw.serverUrl !== "string" || !raw.serverUrl.trim()) {
    throw new Error("host config requires serverUrl");
  }
  if (typeof raw.token !== "string" || !raw.token.trim()) {
    throw new Error("host config requires token");
  }
  return {
    serverUrl: raw.serverUrl.replace(/\/$/, ""),
    token: raw.token,
    codexSessionsDir: expandHome(
      typeof raw.codexSessionsDir === "string" && raw.codexSessionsDir
        ? raw.codexSessionsDir
        : "~/.codex/sessions",
    ),
    qoderProjectsDir: expandHome(
      typeof raw.qoderProjectsDir === "string" && raw.qoderProjectsDir
        ? raw.qoderProjectsDir
        : "~/.qoder/projects",
    ),
    intervalSeconds:
      typeof raw.intervalSeconds === "number" && raw.intervalSeconds > 0
        ? raw.intervalSeconds
        : DEFAULT_INTERVAL_SECONDS,
    debugLogPath:
      typeof raw.debugLogPath === "string" && raw.debugLogPath
        ? expandHome(raw.debugLogPath)
        : undefined,
  };
}

export function readHostConfig(configPath = join(homedir(), ".config", "agent-notify", "host.json")) {
  return parseHostConfig(JSON.parse(readFileSync(configPath, "utf8")));
}

// `ps -axo pid=,command=` -> coarse agent process facts.
export function parseProcessList(psOutput) {
  const processes = [];
  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2].trim();
    if (command.includes("herald-host")) continue; // never count ourselves
    if (RESIDENT_MARKERS.some((marker) => command.includes(marker))) continue;
    const tokens = command.split(/\s+/);
    const basename = (token) => (token.split("/").pop() ?? "").toLowerCase();
    const first = basename(tokens[0]);
    const isAgent =
      AGENT_EXES.has(first) ||
      (RUNTIME_EXES.has(first) && AGENT_EXES.has(basename(tokens[1] ?? "")));
    if (isAgent) {
      processes.push({ pid: Number(match[1]), command: command.slice(0, 200) });
    }
  }
  return processes;
}

// rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl under sessions/YYYY/MM/DD/.
export function scanActiveSessionIds(sessionsDir, nowMs, windowMs = TRANSCRIPT_ACTIVE_WINDOW_MS) {
  const ids = [];
  const listDirs = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  };
  for (const year of listDirs(sessionsDir).slice(-1)) {
    for (const month of listDirs(join(sessionsDir, year)).slice(-1)) {
      for (const day of listDirs(join(sessionsDir, year, month)).slice(-2)) {
        let files;
        try {
          files = readdirSync(join(sessionsDir, year, month, day));
        } catch {
          continue;
        }
        for (const file of files) {
          const match = file.match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i);
          if (!match) continue;
          try {
            const stat = statSync(join(sessionsDir, year, month, day, file));
            if (nowMs - stat.mtimeMs <= windowMs) ids.push(match[1]);
          } catch {
            // raced with rotation; ignore
          }
        }
      }
    }
  }
  return [...new Set(ids)];
}

// Codex rollout files live in sessions/YYYY/MM/DD; Qoder desktop sessions in
// <projectsDir>/<project-slug>/<uuid>.jsonl (flat per project).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scanActiveQoderSessionIds(projectsDir, nowMs, windowMs = TRANSCRIPT_ACTIVE_WINDOW_MS) {
  const ids = [];
  let projects;
  try {
    projects = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return ids;
  }
  for (const project of projects) {
    let files;
    try {
      files = readdirSync(join(projectsDir, project));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const uuid = basename(file, ".jsonl");
      if (!UUID_RE.test(uuid)) continue;
      try {
        const stat = statSync(join(projectsDir, project, file));
        if (nowMs - stat.mtimeMs <= windowMs) ids.push(uuid);
      } catch {
        // raced with rotation; ignore
      }
    }
  }
  return [...new Set(ids)];
}

// Wall-clock jump backwards-or-skipping beyond 2 intervals means the host slept.
export function detectSleepGap(lastTickMs, nowMs, intervalSeconds) {
  if (lastTickMs == null) return undefined;
  const gapMs = nowMs - lastTickMs;
  if (gapMs > intervalSeconds * 1000 * 2 + 15_000) {
    return Math.round(gapMs / 1000);
  }
  return undefined;
}

export async function postJson(serverUrl, token, path, body, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false; // unreachable server: retry next tick, never crash
  } finally {
    clearTimeout(timer);
  }
}

async function collectProcesses() {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseProcessList(stdout);
  } catch {
    return [];
  }
}

function debug(config, record) {
  if (!config.debugLogPath) return;
  try {
    appendFileSync(config.debugLogPath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch {
    // fail-safe
  }
}

export async function tickOnce(config, state, nowMs = Date.now(), deps = {}) {
  const collectProcs = deps.collectProcesses ?? collectProcesses;
  const scan = deps.scanActiveSessionIds ?? scanActiveSessionIds;
  const post = deps.postJson ?? postJson;
  const host = hostname();

  const sleepGapSeconds = detectSleepGap(state.lastTickMs, nowMs, config.intervalSeconds);
  state.lastTickMs = nowMs;

  const heartbeat = await post(config.serverUrl, config.token, "/host-heartbeat", {
    hostname: host,
    bridge_version: BRIDGE_VERSION,
    sleep_gap_seconds: sleepGapSeconds,
  });

  const processes = await collectProcs();
  const sessionIds = [
    ...scan(config.codexSessionsDir, nowMs),
    ...(deps.scanActiveQoderSessionIds ?? scanActiveQoderSessionIds)(
      config.qoderProjectsDir,
      nowMs,
    ),
  ];
  const observationsOk = await post(config.serverUrl, config.token, "/observations", {
    hostname: host,
    ...(sleepGapSeconds != null ? { sleep_gap_seconds: sleepGapSeconds } : {}),
    sessions: sessionIds.map((sessionId) => ({
      session_id: sessionId,
      observed_at_ms: nowMs,
      processes,
    })),
  });

  debug(config, {
    heartbeat,
    observationsOk,
    sleepGapSeconds,
    sessionIds: sessionIds.length,
    processes: processes.length,
  });
  return { heartbeat, observationsOk, sleepGapSeconds };
}

async function main() {
  let config;
  try {
    config = readHostConfig();
  } catch (error) {
    console.error("herald-host: bad config:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }
  const state = {};
  // Fire immediately, then on the interval (LaunchAgent KeepAlive keeps us up,
  // but the loop keeps heartbeats dense while asleep is impossible anyway).
  for (;;) {
    await tickOnce(config, state);
    await new Promise((resolve) => setTimeout(resolve, config.intervalSeconds * 1000));
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
