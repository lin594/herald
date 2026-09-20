import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/monitor/db.js";
import { MonitorStore } from "../../src/monitor/store.js";
import { MonitorNotifier } from "../../src/monitor/notifier.js";
import { MonitorScheduler } from "../../src/monitor/scheduler.js";
import { MonitorHub } from "../../src/monitor/hub.js";
import type { MonitorConfig } from "../../src/monitor/config.js";
import type { IncomingAgentEvent } from "../../src/core/incoming-event.js";
import type { NotificationPayload, NotificationResult } from "../../src/providers/types.js";

const T0 = 1_700_000_000_000;

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
  workspaces: [],
  projectMap: { "/work/repo-a": "Repo A" },
};

function fixture() {
  const store = new MonitorStore(openDatabase(":memory:"));
  const sent: NotificationPayload[] = [];
  const provider = {
    name: "mock",
    send: vi.fn(async (payload: NotificationPayload): Promise<NotificationResult> => {
      sent.push(payload);
      return { ok: true, status: 200 };
    }),
  };
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
  return { store, sent, hub };
}

describe("MonitorHub cooperative emit", () => {
  it("records and notifies a waiting emit, then short-circuits the request", async () => {
    const { store, sent, hub } = fixture();
    const early = await hub.handleIncoming(
      {
        agent: "emit",
        raw: {
          type: "waiting",
          message: "Need a decision on the DB schema",
          project: "Repo A",
          agent_type: "codex",
          session_id: "abc123def",
        },
      } as IncomingAgentEvent,
      "macbook",
      T0,
    );
    expect(early).not.toBeNull();
    expect(early?.status).toBe(200);
    expect(early?.body).toEqual({ ok: true, recorded: true, notified: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].urgency).toBe("time_sensitive");
    expect(sent[0].title).toContain("Repo A");
    const session = store.getSession("macbook:abc123def");
    expect(session?.status).toBe("WAITING_USER");
  });

  it("rejects an unknown emit type with 400", async () => {
    const { hub, sent } = fixture();
    const early = await hub.handleIncoming(
      { agent: "emit", raw: { type: "lunch_break", message: "brb" } } as IncomingAgentEvent,
      "macbook",
      T0,
    );
    expect(early?.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("suppresses duplicate emits with identical content", async () => {
    const { hub, sent } = fixture();
    const event = {
      agent: "emit",
      raw: { type: "failed", message: "same failure", session_id: "s9" },
    } as unknown as IncomingAgentEvent;
    await hub.handleIncoming(event, "macbook", T0);
    const second = await hub.handleIncoming(event, "macbook", T0 + 1000);
    expect(sent).toHaveLength(1);
    expect(second?.body).toEqual({ ok: true, recorded: true, notified: false });
  });

  it("a milestone between failures re-arms the failed notification", async () => {
    const { hub, sent } = fixture();
    const mk = (raw: Record<string, unknown>) =>
      ({ agent: "emit", raw } as unknown as IncomingAgentEvent);
    await hub.handleIncoming(mk({ type: "failed", message: "crash", session_id: "s9" }), "macbook", T0);
    await hub.handleIncoming(mk({ type: "milestone", message: "retry running", session_id: "s9" }), "macbook", T0 + 2000);
    await hub.handleIncoming(mk({ type: "failed", message: "crash", session_id: "s9" }), "macbook", T0 + 3000);
    expect(sent).toHaveLength(3);
  });
});

describe("MonitorHub hook state ingestion", () => {
  it("tracks UserPromptSubmit -> Stop lifecycle without early-returning", async () => {
    const { store, hub, sent } = fixture();
    const prompt = {
      agent: "codex",
      raw: {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-1",
        cwd: "/work/repo-a",
        prompt: "do the thing",
      },
    } as unknown as IncomingAgentEvent;
    expect(await hub.handleIncoming(prompt, "macbook", T0)).toBeNull();
    let session = store.getSession("macbook:sess-1");
    expect(session?.status).toBe("ACTIVE");
    expect(session?.project).toBe("Repo A");
    expect(session?.turnStartedMs).toBe(T0);

    // Short turn: Stop keeps the session ACTIVE (turn != task).
    const stopShort = {
      agent: "codex",
      raw: {
        hook_event_name: "Stop",
        session_id: "sess-1",
        cwd: "/work/repo-a",
        last_assistant_message: "done quickly",
      },
    } as unknown as IncomingAgentEvent;
    await hub.handleIncoming(stopShort, "macbook", T0 + 30_000);
    session = store.getSession("macbook:sess-1");
    expect(session?.status).toBe("ACTIVE");

    // Long turn: Stop means the result is ready for review.
    await hub.handleIncoming(prompt, "macbook", T0 + 60_000);
    await hub.handleIncoming(stopShort, "macbook", T0 + 60_000 + 121_000);
    session = store.getSession("macbook:sess-1");
    expect(session?.status).toBe("WAITING_USER");

    // Hub never sends notifications for hook events.
    expect(sent).toHaveLength(0);
  });

  it("PermissionRequest moves the session to WAITING_USER", async () => {
    const { store, hub } = fixture();
    await hub.handleIncoming(
      {
        agent: "codex",
        raw: { hook_event_name: "PermissionRequest", session_id: "sess-2", cwd: "/work/repo-a" },
      } as unknown as IncomingAgentEvent,
      "macbook",
      T0,
    );
    expect(store.getSession("macbook:sess-2")?.status).toBe("WAITING_USER");
  });

  it("isolates storage failures from the notify pipeline", async () => {
    const { hub } = fixture();
    const broken = {
      agent: "codex",
      raw: { hook_event_name: "Stop" },
    } as unknown as IncomingAgentEvent;
    // no session_id -> recorded as no-op, request pipeline continues
    expect(await hub.handleIncoming(broken, "macbook", T0)).toBeNull();
  });
});
