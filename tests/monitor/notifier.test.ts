import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/monitor/db.js";
import { MonitorStore, fingerprintOf } from "../../src/monitor/store.js";
import { MonitorNotifier } from "../../src/monitor/notifier.js";
import type { MonitorConfig } from "../../src/monitor/config.js";
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
  qoderDir: null,
  workspaces: [],
  projectMap: {},
};

function fixture(over: Partial<MonitorConfig> = {}) {
  const store = new MonitorStore(openDatabase(":memory:"));
  const sent: NotificationPayload[] = [];
  const provider = {
    name: "mock",
    send: vi.fn(async (payload: NotificationPayload): Promise<NotificationResult> => {
      sent.push(payload);
      return { ok: true, status: 200 };
    }),
  };
  return { store, sent, notifier: new MonitorNotifier(store, provider, { ...config, ...over }) };
}

describe("MonitorNotifier", () => {
  it("redacts secrets before sending", async () => {
    const { notifier, sent } = fixture();
    await notifier.notify(
      "macbook:s1",
      { kind: "milestone", level: "active", title: "T", body: "token=supersecretvalue123 done" },
      T0,
    );
    expect(sent[0].body).not.toContain("supersecretvalue123");
    expect(sent[0].body).toContain("[REDACTED]");
  });

  it("groups pushes under the session's agent, defaulting to Codex", async () => {
    const { notifier, sent } = fixture();
    await notifier.notify(
      "macbook:q1",
      { kind: "heartbeat", level: "passive", title: "T", body: "b" },
      T0,
      { group: "Qoder" },
    );
    await notifier.notify(
      "macbook:h1",
      { kind: "host_lost", level: "active", title: "T", body: "b" },
      T0,
    );
    expect(sent.map((payload) => payload.group)).toEqual(["Qoder", "Codex"]);
  });

  it("suppresses bodies that are mostly secret material", async () => {
    const { notifier, sent } = fixture();
    await notifier.notify(
      "macbook:s1",
      {
        kind: "milestone",
        level: "active",
        title: "T",
        body: "api_key=sk-abcdefghijklmnop password=hunter2 Authorization: Bearer xyz123",
      },
      T0,
    );
    expect(sent[0].body).toContain("content suppressed");
  });

  it("caps body length", async () => {
    const { notifier, sent } = fixture({ maxBodyChars: 50 });
    await notifier.notify(
      "macbook:s1",
      { kind: "milestone", level: "active", title: "T", body: "x".repeat(500) },
      T0,
    );
    expect(sent[0].body.length).toBeLessThanOrEqual(60);
  });

  it("maps timeSensitive level onto the payload", async () => {
    const { notifier, sent } = fixture();
    await notifier.notify(
      "macbook:s1",
      { kind: "failed", level: "timeSensitive", title: "T", body: "boom" },
      T0,
    );
    expect(sent[0].urgency).toBe("time_sensitive");
    expect(sent[0].level).toBe("timeSensitive");
  });

  it("dedups identical kind+body and re-notifies after clearFingerprint (FAILED twice)", async () => {
    const { notifier, sent, store } = fixture();
    const n = { kind: "failed", level: "timeSensitive", title: "T", body: "boom" } as const;
    await notifier.notify("macbook:s1", n, T0);
    await notifier.notify("macbook:s1", n, T0 + 1000); // duplicate: suppressed
    expect(sent).toHaveLength(1);

    store.clearFingerprint("macbook:s1", ["failed"]); // e.g. ACTIVE observed in between
    await notifier.notify("macbook:s1", n, T0 + 2000);
    expect(sent).toHaveLength(2);
  });

  it("rate limits heartbeats per hour but counts other kinds separately", async () => {
    const { notifier, sent } = fixture({ heartbeatMaxPerHour: 2 });
    for (let i = 0; i < 4; i++) {
      await notifier.notify(
        "macbook:s1",
        { kind: "heartbeat", level: "passive", title: "T", body: `beat ${i}` },
        T0 + i * 1000,
      );
    }
    expect(sent.filter((p) => p.body.startsWith("beat"))).toHaveLength(2);

    await notifier.notify(
      "macbook:s1",
      { kind: "milestone", level: "active", title: "T", body: "beat 9" },
      T0 + 5000,
    );
    expect(sent.filter((p) => p.body === "beat 9")).toHaveLength(1);
  });

  it("force bypasses dedup", async () => {
    const { notifier, sent } = fixture();
    const n = { kind: "milestone", level: "active", title: "T", body: "same" } as const;
    await notifier.notify("macbook:s1", n, T0);
    await notifier.notify("macbook:s1", n, T0 + 1, { force: true });
    expect(sent).toHaveLength(2);
  });

  it("does not remember the fingerprint when the provider fails", async () => {
    const store = new MonitorStore(openDatabase(":memory:"));
    const provider = {
      name: "mock",
      send: vi.fn(async (): Promise<NotificationResult> => ({ ok: false, error: "down" })),
    };
    const notifier = new MonitorNotifier(store, provider, config);
    const n = { kind: "failed", level: "timeSensitive", title: "T", body: "boom" } as const;
    const first = await notifier.notify("macbook:s1", n, T0);
    const second = await notifier.notify("macbook:s1", n, T0 + 1000);
    expect(first).toBe(false);
    expect(second).toBe(false);
    // The failed send was not remembered as "already notified", so the
    // duplicate was offered to the provider again (retry allowed).
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(store.isDuplicateFingerprint(
      "macbook:s1", "failed", fingerprintOf("macbook:s1", "failed", "boom"),
    )).toBe(false);
  });
});
