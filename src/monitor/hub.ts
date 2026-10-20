import { promises as fs } from "node:fs";
import { basename } from "node:path";
import type { Hono } from "hono";
import type { IncomingAgentEvent } from "../core/incoming-event.js";
import { resolveProjectName } from "../formatters/project-title.js";
import { inputRequestText } from "../core/input-request.js";
import {
  composeTitle,
  digestLine,
  notificationPreview,
  readableProject,
  stateLabel,
} from "../core/notification-text.js";
import type { NamedToken } from "../config/env.js";
import type { MonitorConfig } from "./config.js";
import { MonitorNotifier } from "./notifier.js";
import { agentLabel } from "./statemachine.js";
import type { MonitorScheduler } from "./scheduler.js";
import type { MonitorStore } from "./store.js";
import type { DecidedNotification, EmitKind, SessionStatus } from "./types.js";
import { authenticate } from "../server/auth.js";

const EMIT_KINDS = new Set<EmitKind>([
  "started",
  "milestone",
  "waiting",
  "blocked",
  "failed",
  "completed",
]);

const EMIT_STATUS: Record<EmitKind, SessionStatus> = {
  started: "STARTED",
  milestone: "ACTIVE",
  waiting: "WAITING_USER",
  blocked: "BLOCKED",
  failed: "FAILED",
  completed: "COMPLETED",
};

// Which dedup fingerprints an emit episode clears. An emit never clears its
// own kind: repeating the same message must dedup, while progress (milestone)
// re-arms later state changes (e.g. FAILED again after recovery).
const EMIT_CLEARS: Record<EmitKind, string[]> = {
  started: ["waiting", "blocked", "failed", "possible_stall", "resumed"],
  milestone: ["waiting", "blocked", "failed", "possible_stall", "resumed"],
  waiting: ["blocked", "failed", "possible_stall", "resumed"],
  blocked: ["waiting", "failed", "possible_stall", "resumed"],
  failed: ["waiting", "blocked", "possible_stall", "resumed"],
  completed: ["waiting", "blocked", "failed", "possible_stall", "resumed"],
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface HubDeps {
  store: MonitorStore;
  notifier: MonitorNotifier;
  scheduler: MonitorScheduler;
  config: MonitorConfig;
  tokens: NamedToken[];
  completionMinSeconds: number;
}

export interface EarlyResponse {
  status: number;
  body: unknown;
}

/**
 * Ingests every incoming event (hook events, cooperative emits, host
 * observations and heartbeats) into the durable execution model. Codex hooks
 * share the monitor notifier's severity and durable turn dedup. Other agents
 * retain the upstream notification path, except requests held by the grace
 * policy. Cooperative emits also use the monitor notifier.
 */
export class MonitorHub {
  private readonly startedMs = Date.now();

  constructor(private readonly deps: HubDeps) {}

  async handleIncoming(
    incoming: IncomingAgentEvent,
    tokenName: string,
    nowMs: number,
  ): Promise<EarlyResponse | null> {
    try {
      if (incoming.agent === "emit") {
        return await this.handleEmit(incoming, tokenName, nowMs);
      }
      if (incoming.agent === "codex") {
        const handled = await this.handleCodexHook(incoming, tokenName, nowMs);
        if (handled) return handled;
      }
      if (this.applyHookState(incoming, tokenName, nowMs)) {
        return {
          status: 200,
          body: { ok: true, notified: false, reason: "waiting_grace" },
        };
      }
      return null;
    } catch (error) {
      // Failure isolation: monitoring must never break the notify pipeline.
      console.error(
        "[herald] hub ingest failed:",
        error instanceof Error ? error.message : String(error),
      );
      return incoming.agent === "codex"
        ? { status: 503, body: { ok: false, notified: false, error: "monitor_ingest_failed" } }
        : null;
    }
  }

  /** Codex notifications share the monitor's severity and durable dedup policy. */
  private async handleCodexHook(
    incoming: IncomingAgentEvent,
    tokenName: string,
    nowMs: number,
  ): Promise<EarlyResponse | null> {
    const raw = isRecord(incoming.raw) ? incoming.raw : {};
    const event = str(raw.hook_event_name);
    const id = str(raw.session_id);
    if (!id || !event) return null;
    const handled = ["UserPromptSubmit", "PermissionRequest", "PreToolUse", "PostToolUse", "Stop", "Interrupt", "SessionEnd"];
    if (!handled.includes(event)) return null;
    const key = `${tokenName}:${id}`;
    // Repeated request hooks do not restart the grace period or re-arm a push.
    this.applyHookState(incoming, tokenName, nowMs);
    const session = this.deps.store.getSession(key)!;
    if (event !== "Stop") {
      return { status: 200, body: { ok: true, notified: false, reason:
        event === "PermissionRequest"
          ? this.deps.config.codexApprovalAlerts ? "waiting_grace" : "auto_approval_silent"
          : "state_recorded" } };
    }
    if (raw.stop_hook_active === true) {
      return { status: 200, body: { ok: true, notified: false, reason: "stop_hook_active" } };
    }
    if (session.waitingKind === "input_async" && session.waitingSinceMs !== null) {
      return { status: 200, body: { ok: true, notified: false, reason: "pending_input" } };
    }
    const duration = session.lastTurnMs;
    if (this.deps.completionMinSeconds <= 0 || duration == null || !session.lastTurnKey || duration < this.deps.completionMinSeconds * 1000) {
      return { status: 200, body: { ok: true, notified: false, reason: "short_or_disabled_completion" } };
    }
    const text = notificationPreview(str(raw.last_assistant_message) ?? session.lastMessage ?? "", 160);
    const fallback = this.deps.config.language === "zh" ? "本轮已结束，请查看结果" : "Turn finished; review the result";
    const notified = await this.deps.notifier.notify(key, {
      kind: "completed",
      title: composeTitle(["Codex", readableProject(session.project, this.deps.config.language) ?? readableProject(id, this.deps.config.language), stateLabel("review", this.deps.config.language)]),
      body: [text || fallback,
        digestLine({ turnMs: duration }, this.deps.config.language)].filter(Boolean).join("\n"),
      // A second Stop (or a retry after restart) is still the same turn even
      // when its text changes. Short turns never enter the provider pipeline.
      dedupKey: session.lastTurnKey,
    }, nowMs, { group: "Codex" });
    // A failed provider call remains retryable with this same turn identity.
    return { status: 200, body: { ok: true, notified } };
  }

  // ── hook state ingestion ─────────────────────────────────────────────────

  /**
   * Record the state a hook event reports. Returns true when the event asked
   * for permission and the grace policy is holding that question back — the
   * caller then answers the adapter without notifying, and the monitor decides
   * later whether the wait was real.
   */
  private applyHookState(
    incoming: IncomingAgentEvent,
    tokenName: string,
    nowMs: number,
  ): boolean {
    const raw = isRecord(incoming.raw) ? incoming.raw : {};
    const sessionId = str(raw.session_id) ?? str(raw.thread_id) ?? str(raw["thread-id"]);
    if (!sessionId) return false;
    const hookEvent = str(raw.hook_event_name);
    if (!hookEvent) return false;

    const cwd = str(raw.cwd);
    const key = `${tokenName}:${sessionId}`;
    const previous = this.deps.store.getSession(key);
    if (hookEvent === "Stop" && raw.stop_hook_active === true) return false;
    this.deps.store.upsertSession({
      key,
      sessionId,
      agentType: incoming.agent,
      nowMs,
      workspace: cwd ?? null,
      project: cwd ? this.projectFor(cwd) : null,
      transcriptPath: str(raw.transcript_path) ?? null,
    });
    this.deps.store.recordEvent({
      sessionKey: key,
      source: "hook",
      kind: hookEvent,
      payload: { sessionId, cwd, toolName: str(raw.tool_name) },
      nowMs,
    });

    const fields: Parameters<MonitorStore["updateSession"]>[1] = {
      updatedAtMs: nowMs,
    };
    let clearKinds: string[] = [];

    if (hookEvent === "UserPromptSubmit") {
      fields.status = "ACTIVE";
      fields.lastActivityMs = nowMs;
      fields.turnStartedMs = nowMs;
      fields.waitingSinceMs = null;
      fields.waitingOn = null;
      fields.waitingKind = null;
      fields.waitingToolId = null;
      fields.lastMessage = null;
      fields.lastHeartbeatMs = null;
      fields.lastStage = null;
      fields.lastArtifacts = null;
      // The prompt itself is deliberately not stored: it is the one piece of
      // text on this path that must never reach a push, and keeping it out of
      // the row makes that structural rather than a redaction race.
      clearKinds = ["waiting", "blocked", "failed", "possible_stall", "resumed"];
    } else if (hookEvent === "PermissionRequest") {
      if (incoming.agent === "codex" && !this.deps.config.codexApprovalAlerts) {
        // A request is not evidence that approve-for-me failed or that a human
        // is needed. Keep the event, and let real progress/stall evidence speak.
        return true;
      }
      const sameWait = previous?.status === "WAITING_USER" && previous.waitingKind === "approval" &&
        previous.waitingOn === (str(raw.tool_name)?.slice(0, 200) ?? null);
      fields.status = "WAITING_USER";
      fields.waitingSinceMs = sameWait ? previous.waitingSinceMs : nowMs;
      fields.waitingOn = str(raw.tool_name)?.slice(0, 200) ?? null;
      fields.waitingKind = "approval";
      fields.waitingToolId = str(raw.tool_use_id) ?? null;
      if (!sameWait) clearKinds = ["waiting"];
    } else if (hookEvent === "PreToolUse" && incoming.agent === "codex") {
      const name = str(raw.tool_name)?.split(".").pop();
      if (name !== "request_user_input" && name !== "request_user_input_async") return false;
      const kind = name === "request_user_input_async" ? "input_async" : "input";
      const question = inputRequestText(raw.tool_input, this.deps.config.language);
      fields.status = kind === "input_async" && previous?.turnStartedMs != null ? "ACTIVE" : "WAITING_USER";
      fields.waitingSinceMs = previous && previous.waitingToolId === str(raw.tool_use_id) && previous.waitingKind === kind
        ? previous.waitingSinceMs : nowMs;
      fields.waitingOn = question;
      fields.waitingKind = kind;
      fields.waitingToolId = str(raw.tool_use_id) ?? null;
      if (previous?.waitingToolId !== fields.waitingToolId || previous?.waitingKind !== kind) clearKinds = ["waiting"];
    } else if (hookEvent === "PostToolUse" && incoming.agent === "codex") {
      // Async returns {accepted:true} when the panel opens, not when answered.
      // PostToolUse also recovers questions from already-trusted installations
      // whose older PreToolUse matcher only covered the synchronous tool.
      if (str(raw.tool_name)?.split(".").pop() === "request_user_input_async") {
        if (previous?.status === "COMPLETED" || previous?.status === "FAILED" ||
            previous?.status === "UNKNOWN" && previous.turnStartedMs === null && previous.lastTurnMs === 0) return false;
        const question = inputRequestText(raw.tool_input, this.deps.config.language);
        const same = previous?.waitingKind === "input_async" && previous.waitingToolId === str(raw.tool_use_id);
        if (!same) {
          fields.waitingSinceMs = nowMs;
          fields.waitingOn = question;
          fields.waitingKind = "input_async";
          fields.waitingToolId = str(raw.tool_use_id) ?? null;
          clearKinds = ["waiting"];
        }
        fields.lastActivityMs = nowMs;
        this.deps.store.updateSession(key, fields);
        if (clearKinds.length) this.deps.store.clearFingerprint(key, clearKinds);
        return false;
      }
      if (previous?.waitingKind === "input_async") {
        fields.lastActivityMs = nowMs;
        this.deps.store.updateSession(key, fields);
        return false;
      }
      // A parallel tool completing does not answer a different pending question.
      if (previous?.waitingKind === "input" && (!previous.waitingToolId || previous.waitingToolId !== str(raw.tool_use_id))) return false;
      if (previous?.waitingKind === "approval") {
        const matches = previous.waitingToolId
          ? previous.waitingToolId === str(raw.tool_use_id)
          : previous.waitingOn === str(raw.tool_name);
        if (!matches) return false;
      }
      // Late async hooks after Stop must not re-open an idle turn.
      if (!previous || previous.turnStartedMs === null && previous.status !== "WAITING_USER") return false;
      if (previous.status === "WAITING_USER" && previous.waitingSinceMs === null) return false;
      fields.status = "ACTIVE";
      fields.lastActivityMs = nowMs;
      fields.waitingSinceMs = null;
      fields.waitingOn = null;
      fields.waitingKind = null;
      fields.waitingToolId = null;
      clearKinds = ["waiting", "possible_stall", "resumed"];
    } else if (hookEvent === "Interrupt" && incoming.agent === "codex") {
      fields.status = "UNKNOWN";
      fields.turnStartedMs = null;
      fields.lastTurnMs = 0;
      fields.lastActivityMs = nowMs;
      fields.waitingSinceMs = null;
      fields.waitingOn = null;
      fields.waitingKind = null;
      fields.waitingToolId = null;
      clearKinds = ["waiting", "possible_stall", "resumed"];
    } else if (hookEvent === "Stop") {
      const session = this.deps.store.getSession(key);
      const turnStartedMs = session?.turnStartedMs ?? null;
      const turnSeconds = turnStartedMs == null ? null : (nowMs - turnStartedMs) / 1000;
      if (turnSeconds != null && turnSeconds >= this.deps.completionMinSeconds) {
        fields.status = "WAITING_USER"; // long turn finished: ready for review
      } else {
        fields.status = turnStartedMs === null && session?.status === "WAITING_USER" ? "WAITING_USER" : "ACTIVE";
      }
      fields.turnStartedMs = null;
      // A turn boundary ends any pending question with it: what is left is a
      // review, and the upstream completion push already says so.
      fields.waitingSinceMs = null;
      fields.waitingOn = null;
      // Remember the turn this Stop closed: the push built from this event is
      // about that turn, and the row no longer carries its start.
      fields.lastTurnMs = turnStartedMs == null ? session?.lastTurnMs ?? null : nowMs - turnStartedMs;
      fields.lastTurnKey = turnStartedMs == null ? session?.lastTurnKey ?? null : str(raw.turn_id) ?? `turn-started:${turnStartedMs}`;
      fields.lastActivityMs = turnStartedMs == null ? session?.lastActivityMs ?? nowMs : nowMs;
      fields.waitingKind = null;
      fields.waitingToolId = null;
      fields.lastMessage = str(raw.last_assistant_message)?.slice(0, 200) ?? null;
      // The agent finishing its turn does not answer an async question.
      if (session?.waitingKind === "input_async") {
        fields.status = "WAITING_USER";
        fields.waitingSinceMs = session.waitingSinceMs;
        fields.waitingOn = session.waitingOn;
        fields.waitingKind = session.waitingKind;
        fields.waitingToolId = session.waitingToolId;
      }
    } else if (hookEvent === "Notification") {
      // Qoder/Claude-Code user-facing prompt (permission or idle): the agent
      // is blocked on a human, not on work.
      fields.status = "WAITING_USER";
      fields.waitingSinceMs = nowMs;
      fields.waitingOn = str(raw.message)?.slice(0, 200) ?? null;
      fields.lastMessage = str(raw.message)?.slice(0, 200) ?? null;
    } else if (hookEvent === "StopFailure" || hookEvent === "SessionEnd") {
      fields.status = hookEvent === "StopFailure" ? "FAILED" : incoming.agent === "codex" ? "UNKNOWN" : "COMPLETED";
      fields.turnStartedMs = null;
      fields.lastTurnMs = 0;
      fields.waitingKind = null;
      fields.waitingToolId = null;
      fields.waitingSinceMs = null;
      fields.waitingOn = null;
      fields.lastMessage = str(raw.last_assistant_message)?.slice(0, 200) ?? null;
    } else {
      return false;
    }

    this.deps.store.updateSession(key, fields);
    if (clearKinds.length > 0) {
      this.deps.store.clearFingerprint(key, clearKinds);
    }
    // Only a genuine question is held: a `Stop` that ends a long turn is a
    // review, and the upstream completion push for it is the point of the wait.
    return (
      (hookEvent === "PermissionRequest" || hookEvent === "Notification") &&
      this.deps.config.waitingGraceSeconds > 0
    );
  }

  // ── cooperative emit ─────────────────────────────────────────────────────

  private async handleEmit(
    incoming: IncomingAgentEvent,
    tokenName: string,
    nowMs: number,
  ): Promise<EarlyResponse> {
    const raw = isRecord(incoming.raw) ? incoming.raw : {};
    const kind = str(raw.type) as EmitKind | undefined;
    const message = str(raw.message) ?? "";
    if (!kind || !EMIT_KINDS.has(kind)) {
      return { status: 400, body: { ok: false, error: "emit requires a valid type" } };
    }
    const agentType = str(raw.agent_type) ?? "generic";
    const sessionId = str(raw.session_id) ?? `coop:${str(raw.project ?? "default")}`;
    const hostname = str(raw.hostname) ?? null;
    const project =
      str(raw.project) ?? (str(raw.cwd) ? this.projectFor(str(raw.cwd)!) : null);
    const key = `${tokenName}:${sessionId}`;

    this.deps.store.upsertSession({
      key,
      sessionId,
      agentType,
      nowMs,
      hostname,
      project,
      workspace: str(raw.cwd) ?? null,
    });
    this.deps.store.recordEvent({
      sessionKey: key,
      source: "emit",
      kind,
      payload: { message, project, agentType },
      nowMs,
    });

    const fields: Parameters<MonitorStore["updateSession"]>[1] = {
      status: EMIT_STATUS[kind],
      updatedAtMs: nowMs,
      lastActivityMs: nowMs,
      lastMessage: message.slice(0, 200),
    };
    if (kind !== "waiting") {
      fields.waitingSinceMs = null;
      fields.waitingOn = null;
      fields.waitingKind = null;
      fields.waitingToolId = null;
    }
    if (kind === "milestone" || kind === "completed") {
      fields.lastStage = message.slice(0, 200);
    }
    if (kind === "started") {
      fields.lastHeartbeatMs = null;
    }
    this.deps.store.updateSession(key, fields);
    this.deps.store.clearFingerprint(key, EMIT_CLEARS[kind]);

    const label = stateLabel(kind, this.deps.config.language);
    const notification: DecidedNotification = {
      kind,
      // Strength comes from the severity policy, like every other push, so
      // `HERALD_SEVERITY_MAP=completed=debug` retunes cooperative agents too.
      title: composeTitle([
        agentLabel(agentType),
        readableProject(project, this.deps.config.language) ??
          readableProject(sessionId, this.deps.config.language),
        label,
      ]),
      body: message || label,
    };
    const sent = await this.deps.notifier.notify(key, notification, nowMs, {
      group: agentLabel(agentType),
    });
    return {
      status: 200,
      body: { ok: true, recorded: true, notified: sent },
    };
  }

  private projectFor(cwd: string): string {
    const mapped = resolveProjectName(cwd, this.deps.config.projectMap);
    if (mapped) return mapped;
    return basename(cwd.replace(/\/+$/, "")) || "Unknown";
  }

  /**
   * One compact line of quantitative context for a session, so a push that
   * came from the formatter path can still answer "how long, how much". The
   * turn is the one in flight, or the one a `Stop` just closed.
   */
  digestFor(
    tokenName: string,
    sessionId: string | undefined,
    nowMs = Date.now(),
  ): string | undefined {
    if (!sessionId) return undefined;
    const session = this.deps.store.getSession(`${tokenName}:${sessionId}`);
    if (!session) return undefined;
    return digestLine(
      {
        turnMs:
          session.turnStartedMs != null
            ? nowMs - session.turnStartedMs
            : session.lastTurnMs,
        runningMs: nowMs - session.startedAtMs,
        changedFiles: session.changedFiles,
        insertions: session.insertions,
        deletions: session.deletions,
      },
      this.deps.config.language,
    );
  }

  // ── extra routes ─────────────────────────────────────────────────────────

  registerRoutes(app: Hono): void {
    const requireAuth = (header: string | null | undefined): boolean => {
      return authenticate(header ?? null, this.deps.tokens).ok;
    };

    app.post("/observations", async (c) => {
      if (!requireAuth(c.req.header("authorization"))) {
        return c.json({ ok: false, error: "Unauthorized" }, 401);
      }
      const body = await this.readJson(c.req.raw);
      if (!body) return c.json({ ok: false, error: "Invalid payload" }, 400);
      const nowMs = Date.now();
      const sessions = Array.isArray((body as UnknownRecord).sessions)
        ? ((body as UnknownRecord).sessions as UnknownRecord[])
        : [];
      for (const session of sessions) {
        const sessionId = str(session.session_id);
        if (!sessionId) continue;
        const processes = Array.isArray(session.processes) ? session.processes : [];
        this.deps.scheduler.recordObservation({
          sessionId,
          atMs: num(session.observed_at_ms) ?? nowMs,
          processCount: processes.length,
          sleepGapSeconds: num((body as UnknownRecord).sleep_gap_seconds),
        });
      }
      return c.json({ ok: true });
    });

    app.post("/host-heartbeat", async (c) => {
      if (!requireAuth(c.req.header("authorization"))) {
        return c.json({ ok: false, error: "Unauthorized" }, 401);
      }
      const body = await this.readJson(c.req.raw);
      const hostname = body ? str((body as UnknownRecord).hostname) : undefined;
      if (!hostname) return c.json({ ok: false, error: "Invalid payload" }, 400);
      this.deps.store.recordHostHeartbeat({
        hostname,
        nowMs: Date.now(),
        bridgeVersion: str((body as UnknownRecord).bridge_version),
      });
      return c.json({ ok: true });
    });

    app.get("/sessions", (c) => {
      if (!requireAuth(c.req.header("authorization"))) {
        return c.json({ ok: false, error: "Unauthorized" }, 401);
      }
      return c.json({
        ok: true,
        sessions: this.deps.store.listSessions().map((session) => ({
          sessionId: session.sessionId,
          agentType: session.agentType,
          hostname: session.hostname,
          project: session.project,
          workspace: session.workspace,
          status: session.status,
          startedAt: new Date(session.startedAtMs).toISOString(),
          lastActivity: new Date(session.lastActivityMs).toISOString(),
          lastMessage: session.lastMessage,
          waitingKind: session.waitingKind,
          waitingOn: session.waitingOn,
          changedFiles: session.changedFiles,
          insertions: session.insertions,
          deletions: session.deletions,
          artifacts: session.lastArtifacts,
        })),
      });
    });

    app.get("/status", (c) => {
      const sessions = this.deps.store.listSessions();
      const byStatus: Record<string, number> = {};
      for (const session of sessions) {
        byStatus[session.status] = (byStatus[session.status] ?? 0) + 1;
      }
      return c.json({
        ok: true,
        uptimeSeconds: Math.round((Date.now() - this.startedMs) / 1000),
        sessions: byStatus,
        hosts: this.deps.store.listHosts(),
      });
    });

    app.get("/events", (c) => {
      if (!requireAuth(c.req.header("authorization"))) {
        return c.json({ ok: false, error: "Unauthorized" }, 401);
      }
      return c.json({ ok: true, events: this.deps.store.recentEvents(50) });
    });
  }

  private async readJson(request: Request): Promise<UnknownRecord | null> {
    try {
      const value: unknown = await request.json();
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }
}

