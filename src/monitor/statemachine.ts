import {
  composeTitle,
  digestLine,
  formatDuration,
  readableProject,
  stateLabel,
} from "../core/notification-text.js";
import type { NotificationLanguage } from "../core/language.js";
import type { MonitorConfig } from "./config.js";
import type { DecidedNotification, SessionRecord } from "./types.js";

export interface TickSessionContext {
  session: SessionRecord;
  hostAvailable: boolean;
  processActive: boolean; // related agent/child process seen in recent observations
  transcriptActive: boolean; // rollout file grew since last scan
  /**
   * What the transcript tail says about the last turn: true = work was in
   * flight, false = the turn ended cleanly, null/undefined = no evidence (an
   * unreadable format or a session with no transcript at all).
   */
  turnInFlight?: boolean | null;
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
  return formatDuration(ms, "en");
}

/** Stage/artifact lines, appended to every monitor push that has them. */
function detailLines(
  session: SessionRecord,
  language: NotificationLanguage,
): string[] {
  const lines: string[] = [];
  if (session.lastStage) {
    lines.push(
      `${language === "zh" ? "阶段" : "Stage"}: ${session.lastStage}`,
    );
  }
  if (session.lastArtifacts) {
    lines.push(
      `${language === "zh" ? "产物" : "Artifacts"}: ${session.lastArtifacts}`,
    );
  }
  return lines;
}

/** Quantitative diffstat plus stage/artifacts, for pushes without a clock. */
function contextLines(
  session: SessionRecord,
  language: NotificationLanguage,
): string[] {
  const lines = detailLines(session, language);
  const digest = digestLine(
    {
      changedFiles: session.changedFiles,
      insertions: session.insertions,
      deletions: session.deletions,
    },
    language,
  );
  return digest ? [digest, ...lines] : lines;
}

function heartbeatBody(
  session: SessionRecord,
  nowMs: number,
  language: NotificationLanguage,
): string {
  // "本轮" is the turn in flight; a session between turns has no turn to
  // report, so only the task clock shows.
  const head = digestLine(
    {
      turnMs: session.turnStartedMs == null ? null : nowMs - session.turnStartedMs,
      runningMs: nowMs - session.startedAtMs,
      idleMs: nowMs - session.lastActivityMs,
      changedFiles: session.changedFiles,
      insertions: session.insertions,
      deletions: session.deletions,
    },
    language,
  );
  const details = detailLines(session, language);
  return (head ? [head, ...details] : details).join("\n");
}

/** Display name used for notification titles and Bark group filtering. */
export function agentLabel(agentType: string): string {
  switch (agentType) {
    case "codex":
      return "Codex";
    case "qoder":
      return "Qoder";
    case "claude-code":
      return "Claude Code";
    case "opencode":
      return "OpenCode";
    default:
      return agentType;
  }
}

function titleFor(
  session: SessionRecord,
  kind: string,
  language: NotificationLanguage,
): string {
  return composeTitle([
    agentLabel(session.agentType),
    readableProject(session.project, language) ??
      readableProject(session.sessionId, language),
    stateLabel(kind, language),
  ]);
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
      // A re-baselined clock (wake, restart) can make the quiet episode younger
      // than the threshold; the user never saw it go quiet, so say nothing.
      if (idleMs / 1000 >= config.quietSeconds) {
        result.notifications.push({
          kind: "resumed",
          level: "passive",
          title: titleFor(session, "resumed", config.language),
          body: [
            config.language === "zh"
              ? `恢复活动（已静默 ${formatDuration(idleMs, "zh")}）`
              : `Activity resumed after ${formatElapsed(idleMs)}.`,
            ...contextLines(session, config.language),
          ].join("\n"),
        });
      }
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
    // "Stalled" is a claim about work in flight, so it needs evidence that work
    // *was* in flight. A transcript whose last turn ended cleanly means the
    // silence is the session being over, not the agent hanging: retire it
    // without pushing. null (no transcript evidence) keeps the clock-based
    // notification, so cooperative `emit` agents are unaffected.
    if (ctx.turnInFlight !== false) {
      result.notifications.push({
        kind: "possible_stall",
        level: "timeSensitive",
        title: titleFor(session, "possible_stall", config.language),
        body: [
          config.language === "zh"
            ? `已 ${formatDuration(idleMs, "zh")}没有任何可观察动作`
            : `No observable activity for ${formatElapsed(idleMs)}.`,
          ...contextLines(session, config.language),
        ].join("\n"),
      });
    }
  }

  // Adaptive heartbeat for working sessions only. A session whose transcript
  // ends on a finished turn has nothing to report, however long it lingers.
  const working =
    result.updates.status
      ? result.updates.status === "ACTIVE" || result.updates.status === "QUIET"
      : session.status === "STARTED" || session.status === "ACTIVE" || session.status === "QUIET";

  if (working && ctx.hostAvailable && ctx.turnInFlight !== false) {
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
        title: titleFor(session, "heartbeat", config.language),
        body: heartbeatBody(session, nowMs, config.language),
      });
      result.updates.lastHeartbeatMs = nowMs;
    }
  }

  return result;
}
