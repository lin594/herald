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
  transcriptDir: null,
  qoderDir: null,
  workspaces: [],
  projectMap: {},
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
    expect(sent.filter((p) => p.body.includes("No observable activity"))).toHaveLength(0);
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
      (p) => p.body.includes("No observable activity") || p.title.includes("Host Signal Lost"),
    );
    expect(replayed).toHaveLength(0);

    // A stall can only be reported again after a fresh quiet->stall episode.
    const stallAt = session.lastActivityMs + 1501_000;
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: stallAt });
    await scheduler.run(stallAt);
    expect(sent.filter((p) => p.body.includes("No observable activity"))).toHaveLength(1);
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
    expect(sent.filter((p) => p.body.includes("No observable activity"))).toHaveLength(0);
    // Heartbeats are allowed but must respect the adaptive schedule (<= 3/h).
    expect(sent.filter((p) => p.body.includes("Running"))).toHaveLength(1);
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
    expect(sent.filter((p) => p.body.includes("No observable activity"))).toHaveLength(0);
  });
});
