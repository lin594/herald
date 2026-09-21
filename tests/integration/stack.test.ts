import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/monitor/db.js";
import { MonitorStore } from "../../src/monitor/store.js";
import { MonitorNotifier } from "../../src/monitor/notifier.js";
import { MonitorScheduler } from "../../src/monitor/scheduler.js";
import { MonitorHub } from "../../src/monitor/hub.js";
import { parseMonitorConfig, type MonitorConfig } from "../../src/monitor/config.js";
import type { NotificationPayload, NotificationResult } from "../../src/providers/types.js";

const config: MonitorConfig = parseMonitorConfig({
  CBM_DB_PATH: ":memory:",
  CBM_PROJECT_MAP: "/work/repo-a=Repo A",
});

function harness(dbPath = ":memory:") {
  const sent: NotificationPayload[] = [];
  const provider = {
    name: "mock",
    send: vi.fn(async (payload: NotificationPayload): Promise<NotificationResult> => {
      sent.push(payload);
      return { ok: true, status: 200 };
    }),
  };
  const db = openDatabase(dbPath);
  const store = new MonitorStore(db);
  const notifier = new MonitorNotifier(store, provider, config);
  const scheduler = new MonitorScheduler(store, notifier, config);
  const hub = new MonitorHub({
    store,
    notifier,
    scheduler,
    config,
    tokens: [{ name: "macbook", value: "t0ken" }],
    completionMinSeconds: 120,
  });
  const app = createApp({
    tokens: [{ name: "macbook", value: "t0ken" }],
    provider,
    logPath: "./data/integration.jsonl",
    logRaw: false,
    language: "en",
    claudeCompletionMinSeconds: 120,
    codexCompletionMinSeconds: 120,
    opencodeCompletionMinSeconds: 120,
    cooldownSeconds: 0,
    monitor: hub,
  });
  const auth = { authorization: "Bearer t0ken" };
  return { app, auth, store, notifier, scheduler, sent, db };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

describe("full-stack integration (Tests A/B/D/G/I)", () => {
  it("A: health is open, every data route demands a token", async () => {
    const h = harness();
    expect((await h.app.request("/health")).ok).toBe(true);

    for (const [method, path] of [
      ["post", "/events"],
      ["post", "/observations"],
      ["post", "/host-heartbeat"],
      ["get", "/sessions"],
      ["get", "/events"],
    ] as const) {
      const res = await h.app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    // /status is the unauthenticated local overview used by ./cbm doctor.
    expect((await h.app.request("/status")).ok).toBe(true);
  });

  it("B+I: emit notifies once, redacts secrets, dedups identical repeats", async () => {
    const h = harness();
    const payload = {
      agent: "emit",
      raw: {
        type: "waiting",
        message: "Approve `rm -rf`? token=abc123secret password=hunter2",
        project: "Integration",
        session_id: "int-1",
      },
    };
    const first = await h.app.request("/events", {
      method: "post",
      headers: h.auth,
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    expect((await first.json()).notified).toBe(true);

    const notice = h.sent[0] as NotificationPayload & { level?: string };
    expect(notice.title).toContain("Need Input");
    expect(notice.body).toContain("[REDACTED]");
    expect(notice.body).not.toContain("abc123secret");
    expect(notice.body).not.toContain("hunter2");
    expect(notice.level).toBe("timeSensitive");

    const second = await h.app.request("/events", {
      method: "post",
      headers: h.auth,
      body: JSON.stringify(payload),
    });
    expect((await second.json()).notified).toBe(false);
    expect(h.sent).toHaveLength(1);

    const status = await (await h.app.request("/status")).json();
    expect(status.sessions.WAITING_USER).toBe(1);
  });

  it("C-remote: codex hook events drive state; Stop stays a turn, not completion", async () => {
    const h = harness();
    const hook = (raw: Record<string, unknown>) =>
      h.app.request("/events", {
        method: "post",
        headers: h.auth,
        body: JSON.stringify({ agent: "codex", raw }),
      });

    expect((await hook({ hook_event_name: "UserPromptSubmit", session_id: "cx-1", cwd: "/work/repo-a" })).ok).toBe(true);
    let s = h.store.listSessions().find((x) => x.sessionId === "cx-1")!;
    expect(s.status).toBe("ACTIVE");
    expect(s.project).toBe("Repo A");

    await hook({ hook_event_name: "PermissionRequest", session_id: "cx-1" });
    s = h.store.listSessions().find((x) => x.sessionId === "cx-1")!;
    expect(s.status).toBe("WAITING_USER");

    await hook({ hook_event_name: "Stop", session_id: "cx-1" });
    s = h.store.listSessions().find((x) => x.sessionId === "cx-1")!;
    expect(s.status).not.toBe("COMPLETED"); // a finished turn is not a finished task
  });

  it("C-qoder: qoder hooks share the codex turn gate; Stop is not completion", async () => {
    const h = harness();
    const hook = (raw: Record<string, unknown>) =>
      h.app.request("/events", {
        method: "post",
        headers: h.auth,
        body: JSON.stringify({ agent: "qoder", raw }),
      });
    const session = () => h.store.listSessions().find((x) => x.sessionId === "qd-1")!;

    expect(
      (
        await hook({
          hook_event_name: "UserPromptSubmit",
          session_id: "qd-1",
          cwd: "/work/repo-a",
          transcript_path: "/host/.qoder/projects/-work-repo-a/qd-1.jsonl",
          prompt: "integrate qoder monitoring",
        })
      ).ok,
    ).toBe(true);
    expect(session().status).toBe("ACTIVE");
    expect(session().agentType).toBe("qoder");
    expect(session().project).toBe("Repo A");

    await hook({
      hook_event_name: "PermissionRequest",
      session_id: "qd-1",
      cwd: "/work/repo-a",
      tool_name: "Bash",
      tool_input: { command: "pnpm test", description: "Run the test suite" },
    });
    expect(session().status).toBe("WAITING_USER");
    expect(h.sent.map((p) => p.body)).toContain("Run the test suite");

    // Stop arrives milliseconds after the prompt, so the shared completion gate
    // suppresses it: a short turn is neither a task completion nor a review.
    await hook({
      hook_event_name: "Stop",
      session_id: "qd-1",
      last_assistant_message: "done",
    });
    expect(session().status).not.toBe("COMPLETED");
    expect(h.sent.some((p) => p.body === "done")).toBe(false);
  });

  it("D: host heartbeat + observations are accepted and reported", async () => {
    const h = harness();
    const beat = await h.app.request("/host-heartbeat", {
      method: "post",
      headers: h.auth,
      body: JSON.stringify({ hostname: "iMac.local", bridge_version: "0.1.0" }),
    });
    expect(beat.ok).toBe(true);
    await h.app.request("/observations", {
      method: "post",
      headers: h.auth,
      body: JSON.stringify({
        hostname: "iMac.local",
        sessions: [{ session_id: "cx-1", observed_at_ms: Date.now(), processes: [{ pid: 1, command: "codex" }] }],
      }),
    });
    const status = await (await h.app.request("/status")).json();
    expect(status.hosts).toEqual([
      expect.objectContaining({ hostname: "iMac.local", status: "HOST_AVAILABLE", bridgeVersion: "0.1.0" }),
    ]);
  });

  it("E: scheduler run with injected clocks keeps a busy session un-stalled", async () => {
    const h = harness();
    await h.app.request("/events", {
      method: "post",
      headers: h.auth,
      body: JSON.stringify({ agent: "emit", raw: { type: "started", message: "go", session_id: "int-e" } }),
    });
    const now = Date.now();
    await h.scheduler.run(now + 60_000); // 1 minute in, process seen running
    await h.app.request("/observations", {
      method: "post",
      headers: h.auth,
      body: JSON.stringify({
        hostname: "iMac.local",
        sessions: [{ session_id: "int-e", observed_at_ms: now + 60_000, processes: [{ pid: 9, command: "codex" }] }],
      }),
    });
    await h.scheduler.run(now + 20 * 60_000); // mid-run: 20 min of process activity
    const s = h.store.listSessions().find((x) => x.sessionId === "int-e")!;
    expect(["STARTED", "ACTIVE"].includes(s.status)).toBe(true);
    expect(h.sent.filter((p) => (p as { title?: string }).title?.includes("Stall"))).toHaveLength(0);
  });

  it("H: heartbeats follow the adaptive schedule and the unchanged-content rule", async () => {
    const h = harness();
    const now = Date.now(); // session starts a few ms after this; margins below absorb it
    const running = () =>
      h.sent.filter((p) => (p as { title?: string }).title?.includes("Running")).length;
    const observeAt = async (ms: number) => {
      await h.app.request("/observations", {
        method: "post",
        headers: h.auth,
        body: JSON.stringify({
          hostname: "iMac.local",
          sessions: [{ session_id: "int-h", observed_at_ms: ms, processes: [{ pid: 9, command: "codex" }] }],
        }),
      });
    };

    await h.app.request("/events", {
      method: "post",
      headers: h.auth,
      body: JSON.stringify({ agent: "emit", raw: { type: "started", message: "long job", session_id: "int-h" } }),
    });
    await observeAt(now + 905_000);
    await h.scheduler.run(now + 905_000); // first heartbeat due at 15 min
    expect(running()).toBe(1);

    // Still working 20 min later: interval (30 min since beat 1) and content
    // both advanced -> second beat lands.
    await observeAt(now + 2_720_000);
    await h.scheduler.run(now + 2_720_000);
    expect(running()).toBe(2);

    // Interval not elapsed on the next ticks: activity flows, no heartbeat spam.
    for (let i = 1; i <= 4; i++) {
      await observeAt(now + 2_720_000 + i * 120_000);
      await h.scheduler.run(now + 2_720_000 + i * 120_000);
    }
    expect(running()).toBe(2);
    expect(h.store.listSessions().find((x) => x.sessionId === "int-h")?.status).toBe("ACTIVE");
  });

  it("G: state, dedup and heartbeat counters survive a restart, no replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbm-int-"));
    const file = join(dir, "monitor.sqlite3");
    const a = harness(file);
    const emitWaiting = {
      method: "post",
      headers: a.auth,
      body: JSON.stringify({ agent: "emit", raw: { type: "waiting", message: "decide A or B", session_id: "int-g" } }),
    };
    expect((await a.app.request("/events", emitWaiting)).ok).toBe(true);
    expect((await a.app.request("/events", emitWaiting)).ok).toBe(true);
    expect(a.sent).toHaveLength(1);
    a.db.close();

    const b = harness(file);
    const s = b.store.listSessions().find((x) => x.sessionId === "int-g")!;
    expect(s.status).toBe("WAITING_USER");
    await b.app.request("/events", emitWaiting); // same content after restart
    expect(b.sent).toHaveLength(0); // dedup persisted: never replayed
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  });
});
