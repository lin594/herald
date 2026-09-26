import { z } from "zod";
import type { NotificationLanguage } from "../core/language.js";
import { isSeverity, type NotifySeverity } from "./severity.js";

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
  language: NotificationLanguage; // reuses the upstream AGENT_NOTIFY_LANGUAGE
  /** Pushes below this strength are dropped before anything is sent. */
  minSeverity: NotifySeverity;
  /** Per-kind strength overrides from HERALD_SEVERITY_MAP, e.g. heartbeat=debug. */
  severityMap: Record<string, NotifySeverity>;
  transcriptDir: string | null; // container path, read-only mount of ~/.codex/sessions
  qoderDir: string | null; // container path, read-only mount of ~/.qoder/projects
  workspaces: WorkspaceConfig[];
  projectMap: Record<string, string>; // workspace/host path (or dir name) -> project name
}

function parseWorkspaces(value: string | undefined): WorkspaceConfig[] {
  if (!value?.trim()) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("HERALD_WORKSPACES must be a JSON array");
  return parsed.map((item) => workspaceSchema.parse(item));
}

/**
 * `HERALD_SEVERITY_MAP="possible_stall=critical,heartbeat=debug"`. A pair whose
 * severity is not one of the four tiers is reported and ignored rather than
 * silently retuning the policy: an unread config is worse than no config.
 */
function parseSeverityMap(value: string | undefined): Record<string, NotifySeverity> {
  const out: Record<string, NotifySeverity> = {};
  if (!value?.trim()) return out;
  for (const pair of value.split(/[,;]/)) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const kind = pair.slice(0, idx).trim();
    const severity = pair.slice(idx + 1).trim().toLowerCase();
    if (!kind) continue;
    if (!isSeverity(severity)) {
      console.warn(`[herald] ignoring HERALD_SEVERITY_MAP entry "${pair}"`);
      continue;
    }
    out[kind] = severity;
  }
  return out;
}

function parseMinSeverity(value: string | undefined): NotifySeverity {
  const raw = value?.trim().toLowerCase();
  if (!raw) return "info";
  if (!isSeverity(raw)) {
    console.warn(
      `[herald] ignoring HERALD_MIN_SEVERITY="${value}" (use debug, info, notice or critical)`,
    );
    return "info";
  }
  return raw;
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

function withWorkspaceProjects(
  workspaces: WorkspaceConfig[],
  explicit: Record<string, string>,
): Record<string, string> {
  // A hook payload often carries only the cwd basename, so both the container
  // path and the workspace name are valid keys. HERALD_PROJECT_MAP wins.
  const out: Record<string, string> = {};
  for (const workspace of workspaces) {
    const name = workspace.project ?? workspace.name;
    out[workspace.path] = name;
    out[workspace.name] = name;
  }
  return { ...out, ...explicit };
}

export function parseMonitorConfig(env: NodeJS.ProcessEnv): MonitorConfig {
  const workspaces = parseWorkspaces(env.HERALD_WORKSPACES);
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
    language: env.AGENT_NOTIFY_LANGUAGE === "zh" ? "zh" : "en",
    minSeverity: parseMinSeverity(env.HERALD_MIN_SEVERITY),
    severityMap: parseSeverityMap(env.HERALD_SEVERITY_MAP),
    transcriptDir: env.HERALD_TRANSCRIPT_DIR?.trim() || null,
    qoderDir: env.HERALD_QODER_DIR?.trim() || null,
    workspaces,
    projectMap: withWorkspaceProjects(workspaces, parseProjectMap(env.HERALD_PROJECT_MAP)),
  };
}
