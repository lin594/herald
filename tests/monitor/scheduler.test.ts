import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/monitor/db.js";
import { MonitorStore } from "../../src/monitor/store.js";
import { MonitorNotifier } from "../../src/monitor/notifier.js";
import { MonitorScheduler } from "../../src/monitor/scheduler.js";
import type { MonitorConfig } from "../../src/monitor/config.js";
import type { NotificationPayload, NotificationResult } from "../../src/providers/types.js";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

const config: MonitorConfig = {
  enabled: true,
  dbPath: ":memory:",
  tickSeconds: 15,
  heartbeatFirstSeconds: 900,
  heartbeatNormalSeconds: 1800,
  quietSeconds: 600,
  stallSeconds: 1500,
  heartbeatMaxPerHour: 3,
  hostHeartbeatTimeoutSeconds: 180,
  watchIntervalSeconds: 30,
  gitScanIntervalSeconds: 60,
  scanMaxFiles: 5000,
  maxBodyChars: 1200,
  minSeverity: "info",
  severityMap: {},
  transcriptDir: null,
  qoderDir: null,
  workspaces: [],
  projectMap: {},
  language: "en",
};

function fixture(overrides: Partial<MonitorConfig> = {}, sessionId = "s1") {
  const store = new MonitorStore(openDatabase(":memory:"));
  const sent: NotificationPayload[] = [];
  const provider = {
    name: "mock",
    send: vi.fn(async (payload: NotificationPayload): Promise<NotificationResult> => {
      sent.push(payload);
      return { ok: true, status: 200 };
    }),
  };
  const configWithOverrides: MonitorConfig = { ...config, ...overrides };
  const notifier = new MonitorNotifier(store, provider, configWithOverrides);
  const scheduler = new MonitorScheduler(store, notifier, configWithOverrides);
  const key = `macbook:${sessionId}`;
  store.upsertSession({
    key,
    sessionId,
    agentType: "codex",
    nowMs: T0,
    hostname: "mbp",
    project: "P",
  });
  store.updateSession(key, { status: "ACTIVE", lastActivityMs: T0 });
  store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 });
  return { store, sent, scheduler, key };
}

describe("MonitorScheduler host gap (sleep/wake)", () => {
  it("declares host lost once, and a 12h sleep never becomes a 12h stall", async () => {
    const { store, sent, scheduler } = fixture();

    // Host stops heartbeating (laptop sleeps).
    await scheduler.run(T0 + 400_000);
    expect(store.listHosts()[0].status).toBe("HOST_UNREACHABLE");
    expect(sent.filter((p) => p.title.includes("Host Signal Lost"))).toHaveLength(1);
    const afterLost = sent.length;

    // While unreachable: no stall attribution, no repeated host_lost spam.
    await scheduler.run(T0 + 5 * HOUR);
    expect(sent.filter((p) => p.title.includes("Host Signal Lost"))).toHaveLength(1);
    expect(sent.filter((p) => p.title.includes("Possible Stall"))).toHaveLength(0);
    expect(store.getSession("macbook:s1")?.status).toBe("ACTIVE");

    // Wake up 12h later: host returns.
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 12 * HOUR });
    await scheduler.run(T0 + 12 * HOUR + 1_000);

    expect(store.listHosts()[0].status).toBe("HOST_AVAILABLE");
    const session = store.getSession("macbook:s1")!;
    // Re-baselined: QUIET with a fresh activity clock, never UNKNOWN/stalled.
    expect(session.status).toBe("QUIET");
    expect(session.lastActivityMs).toBe(T0 + 12 * HOUR + 1_000);

    // No replay storm on wake: only the host-return transition itself, which
    // notifies nothing new beyond what already fired before the gap.
    const replayed = sent.slice(afterLost).filter(
      (p) => p.title.includes("Possible Stall") || p.title.includes("Host Signal Lost"),
    );
    expect(replayed).toHaveLength(0);

    // A stall can only be reported again after a fresh quiet->stall episode.
    const stallAt = session.lastActivityMs + 1501_000;
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: stallAt });
    await scheduler.run(stallAt);
    expect(sent.filter((p) => p.title.includes("Possible Stall"))).toHaveLength(1);
    expect(store.getSession("macbook:s1")?.status).toBe("UNKNOWN");
  });

  it("host observations mark process activity and keep long subprocesses un-stalled", async () => {
    const { store, sent, scheduler } = fixture();
    // Bridge reports the agent process every tick during a long compile.
    for (let t = T0 + 60_000; t <= T0 + 20 * 60_000; t += 60_000) {
      store.recordHostHeartbeat({ hostname: "mbp", nowMs: t });
      scheduler.recordObservation({ sessionId: "s1", atMs: t, processCount: 1 });
      await scheduler.run(t);
    }
    const session = store.getSession("macbook:s1")!;
    expect(session.status).toBe("ACTIVE");
    expect(sent.filter((p) => p.title.includes("Possible Stall"))).toHaveLength(0);
    // Heartbeats are allowed but must respect the adaptive schedule (<= 3/h).
    expect(sent.filter((p) => p.body.includes("task running"))).toHaveLength(1);
  });

  it("treats a growing Qoder transcript as activity, without a host process", async () => {
    const QODER_SESSION = "62211ad1-730a-4de1-ae17-8ed9c4fd19a4";
    const dir = join(tmpdir(), `herald-qoder-scan-${T0}`);
    const project = join(dir, "-Users-me-work-repo");
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${QODER_SESSION}.jsonl`);
    writeFileSync(transcript, '{"type":"user"}\n');

    const { store, sent, scheduler } = fixture({ qoderDir: dir }, QODER_SESSION);

    // No hook events and no agent process: a long, quiet model turn.
    const later = T0 + 700_000;
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: later });
    await scheduler.run(later);
    expect(store.getSession(`macbook:${QODER_SESSION}`)?.status).toBe("QUIET");

    // The transcript file grew, which is the only signal that work continued.
    appendFileSync(transcript, '{"type":"assistant"}\n');
    const grown = later + 60_000;
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: grown });
    await scheduler.run(grown);

    const session = store.getSession(`macbook:${QODER_SESSION}`)!;
    expect(session.status).toBe("ACTIVE");
    expect(session.lastActivityMs).toBe(grown);
    expect(sent.filter((p) => p.title.includes("Possible Stall"))).toHaveLength(0);
  });

  it("retires a session whose last turn ended cleanly, without a word", async () => {
    // The regression this guards: a Qoder session that finished (or that the
    // user interrupted) stops appending, so 25 minutes later the clocks alone
    // said "possible stall" for work that was never running.
    const { store, sent, scheduler } = fixture(
      { qoderDir: writeTranscript("ended", [
        '{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn"}}',
        '{"type":"active-leaf"}',
      ]) },
      "ended",
    );

    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 601_000 });
    await scheduler.run(T0 + 601_000);
    expect(store.getSession("macbook:ended")?.status).toBe("QUIET");
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 1501_000 });
    await scheduler.run(T0 + 1501_000);

    expect(store.getSession("macbook:ended")?.status).toBe("UNKNOWN");
    expect(sent).toHaveLength(0); // no stall, and no "still running" heartbeat
  });

  it("still reports a stall when the last turn never came back", async () => {
    const { store, sent, scheduler } = fixture(
      { qoderDir: writeTranscript("hung", [
        '{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use"}}',
        '{"type":"user","message":{"role":"user","content":[{"type":"tool_result"}]}}',
      ]) },
      "hung",
    );

    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 601_000 });
    await scheduler.run(T0 + 601_000);
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 1501_000 });
    await scheduler.run(T0 + 1501_000);

    expect(store.getSession("macbook:hung")?.status).toBe("UNKNOWN");
    expect(sent.filter((p) => p.title.includes("Possible Stall"))).toHaveLength(1);
  });

  it("retires a Codex session whose rollout ends on a completed turn", async () => {
    // The reported regression, at the layer that had it wrong: Codex writes a
    // different JSONL shape from Qoder, so every rollout line was unreadable,
    // "unreadable" became "no evidence", and a session that had finished its
    // turn was announced as possibly stalled 25 minutes later.
    const { store, sent, scheduler } = fixture(
      { transcriptDir: writeRollout(CODEX_THREAD, [
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"01a0dd73-3142-7903-9d99-fbbb6951af2f"}}',
        '{"type":"response_item","payload":{"type":"reasoning"}}',
        '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"01a0dd73-3142-7903-9d99-fbbb6951af2f","duration_ms":105188}}',
        '{"type":"event_msg","payload":{"type":"thread_settings_applied"}}',
      ]) },
      CODEX_THREAD,
    );

    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 601_000 });
    await scheduler.run(T0 + 601_000);
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 1501_000 });
    await scheduler.run(T0 + 1501_000);

    expect(store.getSession(`macbook:${CODEX_THREAD}`)?.status).toBe("UNKNOWN");
    expect(sent).toHaveLength(0);
  });

  it("reports a Codex stall as a visible push, not an interruption", async () => {
    const { store, sent, scheduler } = fixture(
      { transcriptDir: writeRollout(CODEX_THREAD, [
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"01a0dd73-3142-7903-9d99-fbbb6951af2f"}}',
        '{"type":"event_msg","payload":{"type":"token_count"}}',
      ]) },
      CODEX_THREAD,
    );

    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 601_000 });
    await scheduler.run(T0 + 601_000);
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 1501_000 });
    await scheduler.run(T0 + 1501_000);

    const stall = sent.filter((p) => p.title.includes("Possible Stall"));
    expect(stall).toHaveLength(1);
    // `notice` strength: an ordinary alert, not a Focus-breaking one.
    expect(stall[0].level).toBe("active");
  });

  it("treats a hook that closed the turn as evidence of idle, without a transcript", async () => {
    // Codex reports `transcript_path: null` for some of its own sessions, so the
    // hook's turn accounting is all we have. A `Stop` that ended the last turn
    // says the silence is the session being over, not a missing instrument.
    const { store, sent, scheduler } = fixture({}, "blind");
    store.updateSession("macbook:blind", {
      status: "QUIET",
      lastActivityMs: T0,
      turnStartedMs: null,
      lastTurnMs: 200_000,
    });
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 1501_000 });
    await scheduler.run(T0 + 1501_000);

    expect(store.getSession("macbook:blind")?.status).toBe("UNKNOWN");
    expect(sent).toHaveLength(0);
  });

  it("says so when only a clock is reporting", async () => {
    // No transcript and no turn ever reported: genuinely unobservable, so the
    // push must not accuse the agent of stalling, and must not interrupt for it.
    const { store, sent, scheduler } = fixture({}, "blind");
    store.updateSession("macbook:blind", {
      status: "QUIET",
      lastActivityMs: T0,
      turnStartedMs: null,
      lastTurnMs: null,
    });
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0 + 1501_000 });
    await scheduler.run(T0 + 1501_000);

    const stall = sent.filter((p) => p.title.includes("Possible Stall"));
    expect(stall).toHaveLength(1);
    expect(stall[0].level).toBe("passive");
    expect(stall[0].body).toContain("by clock alone");
  });
});

/** Lay out <tmp>/<project-slug>/<sessionId>.jsonl and return the scan root. */
function writeTranscript(sessionId: string, records: string[]): string {
  const root = join(tmpdir(), `herald-turn-${sessionId}-${T0}`);
  mkdirSync(join(root, "-Users-me-work-repo"), { recursive: true });
  writeFileSync(join(root, "-Users-me-work-repo", `${sessionId}.jsonl`), records.join("\n") + "\n");
  return root;
}

const CODEX_THREAD = "01a0dd70-f663-7152-bca4-f7cd91afbd4b";

/** Lay out a Codex rollout the way ~/.codex/sessions really looks. */
function writeRollout(sessionId: string, records: string[]): string {
  const root = join(tmpdir(), `herald-rollout-${sessionId}-${T0}`);
  const day = join(root, "2026", "09", "20");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, `rollout-2026-09-20T10-00-00-${sessionId}.jsonl`),
    records.join("\n") + "\n",
  );
  return root;
}
