import { z } from "zod";

export interface WorkspaceConfig {
  name: string;
  path: string; // container path
  project?: string;
  artifacts: string[]; // glob patterns
}

const emptyStringToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema) as unknown as T;

const workspaceSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  project: emptyStringToUndefined(z.string().min(1).optional()),
  artifacts: z.array(z.string()).default([]),
});

export interface MonitorConfig {
  enabled: boolean;
  dbPath: string;
  tickSeconds: number;
  heartbeatFirstSeconds: number;
  heartbeatNormalSeconds: number;
  quietSeconds: number;
  stallSeconds: number;
  heartbeatMaxPerHour: number;
  hostHeartbeatTimeoutSeconds: number;
  watchIntervalSeconds: number;
  gitScanIntervalSeconds: number;
  scanMaxFiles: number;
  maxBodyChars: number;
  transcriptDir: string | null; // container path, read-only mount of ~/.codex/sessions
  qoderDir: string | null; // container path, read-only mount of ~/.qoder/projects
  workspaces: WorkspaceConfig[];
  projectMap: Record<string, string>; // workspace/host path -> project name
}

function parseWorkspaces(value: string | undefined): WorkspaceConfig[] {
  if (!value?.trim()) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("HERALD_WORKSPACES must be a JSON array");
  return parsed.map((item) => workspaceSchema.parse(item));
}

function parseProjectMap(value: string | undefined): Record<string, string> {
  // Format: "path=Name;path2=Name2"
  const out: Record<string, string> = {};
  if (!value?.trim()) return out;
  for (const pair of value.split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

export function parseMonitorConfig(env: NodeJS.ProcessEnv): MonitorConfig {
  return {
    enabled: (env.HERALD_ENABLED ?? "true") !== "false",
    dbPath: env.HERALD_DB_PATH ?? "./data/monitor.sqlite3",
    tickSeconds: Number(env.HERALD_TICK_SECONDS ?? 15),
    heartbeatFirstSeconds: Number(env.HERALD_HEARTBEAT_FIRST_SECONDS ?? 900),
    heartbeatNormalSeconds: Number(env.HERALD_HEARTBEAT_NORMAL_SECONDS ?? 1800),
    quietSeconds: Number(env.HERALD_QUIET_SECONDS ?? 600),
    stallSeconds: Number(env.HERALD_STALL_SECONDS ?? 1500),
    heartbeatMaxPerHour: Number(env.HERALD_HEARTBEAT_MAX_PER_HOUR ?? 3),
    hostHeartbeatTimeoutSeconds: Number(env.HERALD_HOST_HEARTBEAT_TIMEOUT_SECONDS ?? 180),
    watchIntervalSeconds: Number(env.HERALD_WATCH_INTERVAL_SECONDS ?? 30),
    gitScanIntervalSeconds: Number(env.HERALD_GIT_SCAN_INTERVAL_SECONDS ?? 60),
    scanMaxFiles: Number(env.HERALD_SCAN_MAX_FILES ?? 5000),
    maxBodyChars: Number(env.HERALD_MAX_BODY_CHARS ?? 1200),
    transcriptDir: env.HERALD_TRANSCRIPT_DIR?.trim() || null,
    qoderDir: env.HERALD_QODER_DIR?.trim() || null,
    workspaces: parseWorkspaces(env.HERALD_WORKSPACES),
    projectMap: parseProjectMap(env.HERALD_PROJECT_MAP),
  };
}
