import type { MonitorConfig } from "./config.js";
import type { DecidedNotification, SessionRecord } from "./types.js";

export interface TickSessionContext {
  session: SessionRecord;
  hostAvailable: boolean;
  processActive: boolean; // related agent/child process seen in recent observations
  transcriptActive: boolean; // rollout file grew since last scan
}

export interface TickResult {
  updates: Partial<{
    status: SessionRecord["status"];
    lastActivityMs: number;
    lastHeartbeatMs: number;
  }>;
  notifications: DecidedNotification[];
  clearedDedupKinds: string[];
}

export function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function heartbeatBody(session: SessionRecord, nowMs: number): string {
  const lines: string[] = [];
  lines.push(`Running ${formatElapsed(nowMs - session.startedAtMs)}`);
  lines.push(`Last activity ${formatElapsed(nowMs - session.lastActivityMs)} ago`);
  if (session.changedFiles > 0) {
    lines.push(`${session.changedFiles} files changed`);
  }
  if (session.insertions > 0 || session.deletions > 0) {
    lines.push(`+${session.insertions} / -${session.deletions}`);
  }
  if (session.lastStage) lines.push(`Stage: ${session.lastStage}`);
  if (session.lastArtifacts) lines.push(`Artifacts: ${session.lastArtifacts}`);
  return lines.join("\n");
}

/** Display name used for notification titles and Bark group filtering. */
export function agentLabel(agentType: string): string {
  return agentType === "codex"
    ? "Codex"
    : agentType === "qoder"
      ? "Qoder"
      : agentType;
}

function titleFor(session: SessionRecord, label: string): string {
  return `[${agentLabel(session.agentType)}] ${
    session.project ?? session.sessionId.slice(0, 8)
  } · ${label}`;
}

/**
 * Pure per-tick evaluation for one session. Clock and config are injected so
 * tests can run the full quiet/stall/heartbeat lifecycle in seconds.
 */
export function evaluateSessionTick(
  ctx: TickSessionContext,
  config: MonitorConfig,
  nowMs: number,
): TickResult {
  const { session } = ctx;
  const result: TickResult = { updates: {}, notifications: [], clearedDedupKinds: [] };

  const anyActivity = ctx.transcriptActive || ctx.processActive;

  const terminal =
    session.status === "COMPLETED" || session.status === "FAILED";
  const needsUser =
    session.status === "WAITING_USER" || session.status === "BLOCKED";

  if (needsUser || terminal) {
    // Waiting/blocked/failed/completed: user-facing state already announced;
    // activity while waiting means the user answered, so return to ACTIVE.
    // FAILED/COMPLETED are only re-opened through event ingestion.
    if (needsUser && anyActivity) {
      result.updates.status = "ACTIVE";
      result.updates.lastActivityMs = nowMs;
      result.clearedDedupKinds.push("waiting", "blocked", "possible_stall", "failed");
    }
    return result;
  }

  const idleMs = nowMs - session.lastActivityMs;

  if (
    (session.status === "QUIET" || session.status === "STARTED" || session.status === "ACTIVE") &&
    !ctx.hostAvailable
  ) {
    // Host is unreachable: could be sleep. Never attribute to agent stall.
    return result;
  }

  if (anyActivity) {
    if (session.status === "QUIET") {
      // resumed from quiet — one low-priority notification per episode
      result.updates.status = "ACTIVE";
      result.updates.lastActivityMs = nowMs;
      result.notifications.push({
        kind: "resumed",
        level: "passive",
        title: titleFor(session, "Resumed"),
        body: `Activity resumed after ${formatElapsed(idleMs)}.`,
      });
      result.clearedDedupKinds.push("possible_stall", "resumed");
    } else {
      result.updates.lastActivityMs = nowMs;
      if (session.status === "STARTED") result.updates.status = "ACTIVE";
    }
    result.clearedDedupKinds.push("possible_stall", "resumed");
  } else if (session.status === "ACTIVE" && idleMs / 1000 >= config.quietSeconds) {
    result.updates.status = "QUIET";
  } else if (
    session.status === "QUIET" &&
    idleMs / 1000 >= config.stallSeconds &&
    ctx.hostAvailable
  ) {
    // Stall requires: no cooperative/hook event, no process, no transcript
    // growth, no workspace change, and host availability. One notification
    // per episode (deduped downstream by fingerprint).
    result.updates.status = "UNKNOWN";
    result.notifications.push({
      kind: "possible_stall",
      level: "timeSensitive",
      title: titleFor(session, "Possible Stall"),
      body: `No observable activity for ${formatElapsed(idleMs)}.`,
    });
  }

  // Adaptive heartbeat for working sessions only.
  const working =
    result.updates.status
      ? result.updates.status === "ACTIVE" || result.updates.status === "QUIET"
      : session.status === "STARTED" || session.status === "ACTIVE" || session.status === "QUIET";

  if (working && ctx.hostAvailable) {
    const sinceStart = nowMs - session.startedAtMs;
    const firstDue = session.lastHeartbeatMs == null;
    const interval = firstDue
      ? config.heartbeatFirstSeconds * 1000
      : config.heartbeatNormalSeconds * 1000;
    const sinceBeat = firstDue
      ? sinceStart
      : nowMs - (session.lastHeartbeatMs ?? nowMs);
    const due = firstDue
      ? sinceStart >= interval
      : sinceBeat >= interval;
    // Only notify when something changed since the last heartbeat. `>=`
    // because activity on this very tick sets lastActivityMs = nowMs: a
    // session with a running process always has fresh content to report,
    // while a frozen clock (QUIET, no activity) stays exactly equal and is
    // skipped.
    const changedSinceBeat =
      firstDue ||
      session.lastActivityMs >= (session.lastHeartbeatMs ?? 0);
    if (due && changedSinceBeat) {
      result.notifications.push({
        kind: "heartbeat",
        level: "passive",
        title: titleFor(session, "Running"),
        body: heartbeatBody(session, nowMs),
      });
      result.updates.lastHeartbeatMs = nowMs;
    }
  }

  return result;
}
