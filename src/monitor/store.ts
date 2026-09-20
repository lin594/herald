import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  HostStateRecord,
  HostStatus,
  SessionRecord,
  SessionStatus,
} from "./types.js";

type Row = Record<string, unknown>;

function rowToSession(row: Row | undefined): SessionRecord | undefined {
  if (!row) return undefined;
  return {
    key: String(row.key),
    sessionId: String(row.session_id),
    agentType: String(row.agent_type),
    hostname: (row.hostname as string) ?? null,
    project: (row.project as string) ?? null,
    workspace: (row.workspace as string) ?? null,
    transcriptPath: (row.transcript_path as string) ?? null,
    status: String(row.status) as SessionStatus,
    startedAtMs: Number(row.started_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    lastActivityMs: Number(row.last_activity_ms),
    turnStartedMs: row.turn_started_ms == null ? null : Number(row.turn_started_ms),
    lastHeartbeatMs: row.last_heartbeat_ms == null ? null : Number(row.last_heartbeat_ms),
    lastStage: (row.last_stage as string) ?? null,
    lastMessage: (row.last_message as string) ?? null,
    changedFiles: Number(row.changed_files),
    insertions: Number(row.insertions),
    deletions: Number(row.deletions),
    lastArtifacts: (row.last_artifacts as string) ?? null,
  };
}

export class MonitorStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertSession(input: {
    key: string;
    sessionId: string;
    agentType: string;
    nowMs: number;
    hostname?: string | null;
    project?: string | null;
    workspace?: string | null;
    transcriptPath?: string | null;
  }): void {
    const existing = this.getSession(input.key);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO sessions (key, session_id, agent_type, hostname, project, workspace,
            transcript_path, status, started_at_ms, updated_at_ms, last_activity_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'UNKNOWN', ?, ?, ?)`,
        )
        .run(
          input.key,
          input.sessionId,
          input.agentType,
          input.hostname ?? null,
          input.project ?? null,
          input.workspace ?? null,
          input.transcriptPath ?? null,
          input.nowMs,
          input.nowMs,
          input.nowMs,
        );
      return;
    }
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    const optional = {
      hostname: input.hostname,
      project: input.project,
      workspace: input.workspace,
      transcript_path: input.transcriptPath,
    };
    for (const [column, value] of Object.entries(optional)) {
      if (value !== undefined && value !== null) {
        sets.push(`${column} = ?`);
        args.push(value);
      }
    }
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE key = ?`)
        .run(...args, input.key);
    }
  }

  getSession(key: string): SessionRecord | undefined {
    return rowToSession(
      this.db.prepare("SELECT * FROM sessions WHERE key = ?").get(key) as Row | undefined,
    );
  }

  listSessions(): SessionRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions ORDER BY updated_at_ms DESC LIMIT 200")
        .all() as Row[]
    ).map((row) => rowToSession(row)!) as SessionRecord[];
  }

  updateSession(
    key: string,
    fields: Partial<{
      status: SessionStatus;
      lastActivityMs: number | null;
      updatedAtMs: number | null;
      turnStartedMs: number | null;
      lastHeartbeatMs: number | null;
      lastStage: string | null;
      lastMessage: string | null;
      changedFiles: number;
      insertions: number;
      deletions: number;
      lastArtifacts: string | null;
    }>,
  ): void {
    const columns: Record<string, string> = {
      status: "status",
      lastActivityMs: "last_activity_ms",
      updatedAtMs: "updated_at_ms",
      turnStartedMs: "turn_started_ms",
      lastHeartbeatMs: "last_heartbeat_ms",
      lastStage: "last_stage",
      lastMessage: "last_message",
      changedFiles: "changed_files",
      insertions: "insertions",
      deletions: "deletions",
      lastArtifacts: "last_artifacts",
    };
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [field, value] of Object.entries(fields)) {
      const column = columns[field];
      if (!column) continue;
      sets.push(`${column} = ?`);
      args.push(value as string | number | null);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE key = ?`).run(...args, key);
  }

  recordEvent(input: {
    sessionKey: string | null;
    source: string;
    kind: string;
    payload: unknown;
    nowMs: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO events (session_key, source, kind, payload_json, received_at_ms) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        input.sessionKey,
        input.source,
        input.kind,
        JSON.stringify(input.payload).slice(0, 20000),
        input.nowMs,
      );
    this.db
      .prepare(
        `DELETE FROM events WHERE id <= (
           SELECT MAX(id) - 5000 FROM events
         )`,
      )
      .run();
  }

  recentEvents(limit = 20): unknown[] {
    return (
      this.db
        .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
        .all(limit) as Row[]
    ).map((row) => ({
      id: Number(row.id),
      sessionKey: row.session_key,
      source: row.source,
      kind: row.kind,
      receivedAt: new Date(Number(row.received_at_ms)).toISOString(),
    }));
  }

  // ── dedup ────────────────────────────────────────────────────────────────

  isDuplicateFingerprint(sessionKey: string, kind: string, fingerprint: string): boolean {
    const row = this.db
      .prepare("SELECT fingerprint FROM dedup_state WHERE session_key = ? AND kind = ?")
      .get(sessionKey, kind) as { fingerprint: string } | undefined;
    return row?.fingerprint === fingerprint;
  }

  rememberFingerprint(
    sessionKey: string,
    kind: string,
    fingerprint: string,
    nowMs: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO dedup_state (session_key, kind, fingerprint, notified_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_key, kind) DO UPDATE SET
           fingerprint = excluded.fingerprint, notified_at_ms = excluded.notified_at_ms`,
      )
      .run(sessionKey, kind, fingerprint, nowMs);
  }

  clearFingerprint(sessionKey: string, kinds: string[]): void {
    for (const kind of kinds) {
      this.db
        .prepare("DELETE FROM dedup_state WHERE session_key = ? AND kind = ?")
        .run(sessionKey, kind);
    }
  }

  countNotificationsSince(sessionKey: string, kind: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE session_key = ? AND kind = ? AND sent_at_ms >= ? AND ok = 1",
      )
      .get(sessionKey, kind, sinceMs) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  recordNotification(input: {
    sessionKey: string | null;
    kind: string;
    level: string;
    title: string;
    body: string;
    nowMs: number;
    ok: boolean;
    error?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO notifications (session_key, kind, level, fingerprint, title, body, sent_at_ms, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionKey,
        input.kind,
        input.level,
        fingerprintOf(input.kind, input.title, input.body),
        input.title,
        input.body.slice(0, 2000),
        input.nowMs,
        input.ok ? 1 : 0,
        input.error ?? null,
      );
  }

  lastNotificationMs(sessionKey: string, kinds: string[]): number | null {
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT MAX(sent_at_ms) AS ms FROM notifications WHERE session_key = ? AND kind IN (${placeholders}) AND ok = 1`,
      )
      .get(sessionKey, ...kinds) as { ms: number | null } | undefined;
    return row?.ms == null ? null : Number(row.ms);
  }

  // ── host state ───────────────────────────────────────────────────────────

  recordHostHeartbeat(input: {
    hostname: string;
    nowMs: number;
    bridgeVersion?: string;
  }): void {
    // Status transitions are owned by the scheduler's evaluateHosts, which
    // detects the UNREACHABLE -> AVAILABLE recovery and re-baselines sessions.
    // A heartbeat here must not mask that transition.
    this.db
      .prepare(
        `INSERT INTO host_state (hostname, last_heartbeat_ms, status, bridge_version, updated_at_ms)
         VALUES (?, ?, 'HOST_AVAILABLE', ?, ?)
         ON CONFLICT(hostname) DO UPDATE SET
           last_heartbeat_ms = excluded.last_heartbeat_ms,
           bridge_version = excluded.bridge_version,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        input.hostname,
        input.nowMs,
        input.bridgeVersion ?? null,
        input.nowMs,
      );
  }

  listHosts(): HostStateRecord[] {
    return (
      this.db.prepare("SELECT * FROM host_state").all() as Row[]
    ).map((row) => ({
      hostname: String(row.hostname),
      lastHeartbeatMs:
        row.last_heartbeat_ms == null ? null : Number(row.last_heartbeat_ms),
      status: String(row.status) as HostStatus,
      bridgeVersion: (row.bridge_version as string) ?? null,
    }));
  }

  setHostStatus(hostname: string, status: HostStatus, nowMs: number): void {
    this.db
      .prepare(
        "UPDATE host_state SET status = ?, updated_at_ms = ? WHERE hostname = ?",
      )
      .run(status, nowMs, hostname);
  }

  // ── persistent helpers injected into upstream policies ──────────────────

  cooldownStore(): { get(key: string): number | undefined; set(key: string, ms: number): void } {
    const db = this.db;
    return {
      get(key) {
        const row = db
          .prepare("SELECT last_ms FROM cooldown_state WHERE key = ?")
          .get(key) as { last_ms: number } | undefined;
        return row ? Number(row.last_ms) : undefined;
      },
      set(key, ms) {
        db.prepare(
          `INSERT INTO cooldown_state (key, last_ms) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET last_ms = excluded.last_ms`,
        ).run(key, ms);
      },
    };
  }

  turnStore(): {
    get(key: string): { startedAtMs: number } | undefined;
    set(key: string, state: { startedAtMs: number }): void;
    delete(key: string): void;
  } {
    const db = this.db;
    return {
      get(key) {
        const row = db
          .prepare("SELECT started_at_ms FROM turn_state WHERE key = ?")
          .get(key) as { started_at_ms: number } | undefined;
        return row ? { startedAtMs: Number(row.started_at_ms) } : undefined;
      },
      set(key, state) {
        db.prepare(
          `INSERT INTO turn_state (key, started_at_ms) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET started_at_ms = excluded.started_at_ms`,
        ).run(key, state.startedAtMs);
      },
      delete(key) {
        db.prepare("DELETE FROM turn_state WHERE key = ?").run(key);
      },
    };
  }
}

export function fingerprintOf(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex");
}
