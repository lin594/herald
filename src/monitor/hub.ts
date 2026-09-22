import { promises as fs } from "node:fs";
import { basename } from "node:path";
import type { Hono } from "hono";
import type { IncomingAgentEvent } from "../core/incoming-event.js";
import { resolveProjectName } from "../formatters/project-title.js";
import {
  composeTitle,
  digestLine,
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

const EMIT_LEVELS: Record<EmitKind, DecidedNotification["level"]> = {
  started: "passive",
  milestone: "active",
  waiting: "timeSensitive",
  blocked: "timeSensitive",
  failed: "timeSensitive",
  completed: "active",
};

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
 * observations and heartbeats) into the durable execution model. Hook-agent
 * events only update state here — user-facing notification for those stays on
 * the existing upstream path. Emit events notify through the monitor notifier
 * (dedup + rate limit + persistence).
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
      this.applyHookState(incoming, tokenName, nowMs);
      return null;
    } catch (error) {
      // Failure isolation: monitoring must never break the notify pipeline.
      console.error(
        "[herald] hub ingest failed:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  // ── hook state ingestion ─────────────────────────────────────────────────

  private applyHookState(incoming: IncomingAgentEvent, tokenName: string, nowMs: number): void {
    const raw = isRecord(incoming.raw) ? incoming.raw : {};
    const sessionId = str(raw.session_id) ?? str(raw.thread_id) ?? str(raw["thread-id"]);
    if (!sessionId) return;
    const hookEvent = str(raw.hook_event_name);
    if (!hookEvent) return;

    const cwd = str(raw.cwd);
    const key = `${tokenName}:${sessionId}`;
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
      fields.lastMessage = str(raw.prompt)?.slice(0, 200) ?? null;
      clearKinds = ["waiting", "blocked", "failed", "possible_stall", "resumed"];
    } else if (hookEvent === "PermissionRequest") {
      fields.status = "WAITING_USER";
      clearKinds = ["waiting"];
    } else if (hookEvent === "Stop") {
      const session = this.deps.store.getSession(key);
      const turnStartedMs = session?.turnStartedMs ?? null;
      const turnSeconds = turnStartedMs == null ? null : (nowMs - turnStartedMs) / 1000;
      if (turnSeconds != null && turnSeconds >= this.deps.completionMinSeconds) {
        fields.status = "WAITING_USER"; // long turn finished: ready for review
      } else {
        fields.status = "ACTIVE";
      }
      fields.turnStartedMs = null;
      // Remember the turn this Stop closed: the push built from this event is
      // about that turn, and the row no longer carries its start.
      fields.lastTurnMs = turnStartedMs == null ? null : nowMs - turnStartedMs;
      fields.lastActivityMs = nowMs;
      fields.lastMessage = str(raw.last_assistant_message)?.slice(0, 200) ?? null;
    } else if (hookEvent === "Notification") {
      // Qoder/Claude-Code user-facing prompt (permission or idle): the agent
      // is blocked on a human, not on work.
      fields.status = "WAITING_USER";
      fields.lastMessage = str(raw.message)?.slice(0, 200) ?? null;
    } else if (hookEvent === "StopFailure" || hookEvent === "SessionEnd") {
      fields.status = hookEvent === "StopFailure" ? "FAILED" : "COMPLETED";
      fields.lastMessage = str(raw.last_assistant_message)?.slice(0, 200) ?? null;
    } else {
      return;
    }

    this.deps.store.updateSession(key, fields);
    if (clearKinds.length > 0) {
      this.deps.store.clearFingerprint(key, clearKinds);
    }
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
      level: EMIT_LEVELS[kind],
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

