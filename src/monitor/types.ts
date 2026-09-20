// Shared types for the execution-monitor layer (see docs/upstream-gap-analysis.md).

export type SessionStatus =
  | "UNKNOWN"
  | "STARTED"
  | "ACTIVE"
  | "QUIET"
  | "WAITING_USER"
  | "BLOCKED"
  | "FAILED"
  | "COMPLETED";

export type HostStatus = "HOST_AVAILABLE" | "HOST_UNREACHABLE";

export type EmitKind =
  | "started"
  | "milestone"
  | "waiting"
  | "blocked"
  | "failed"
  | "completed";

export interface SessionRecord {
  key: string; // `${tokenName}:${sessionId}`
  sessionId: string;
  agentType: string;
  hostname: string | null;
  project: string | null;
  workspace: string | null;
  transcriptPath: string | null;
  status: SessionStatus;
  startedAtMs: number;
  updatedAtMs: number;
  lastActivityMs: number;
  turnStartedMs: number | null;
  lastHeartbeatMs: number | null;
  lastStage: string | null; // last milestone/completed message
  lastMessage: string | null; // last human-readable event message
  changedFiles: number;
  insertions: number;
  deletions: number;
  lastArtifacts: string | null;
}

export interface HostStateRecord {
  hostname: string;
  lastHeartbeatMs: number | null;
  status: HostStatus;
  bridgeVersion: string | null;
}

export type MonitorNotificationKind =
  | "heartbeat"
  | "possible_stall"
  | "resumed"
  | "host_lost";

export interface DecidedNotification {
  kind: MonitorNotificationKind | EmitKind;
  level: "passive" | "active" | "timeSensitive";
  title: string;
  body: string;
  dedupKey?: string;
}
