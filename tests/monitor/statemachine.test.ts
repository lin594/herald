import { describe, expect, it } from "vitest";
import { evaluateSessionTick, formatElapsed } from "../../src/monitor/statemachine.js";
import type { MonitorConfig } from "../../src/monitor/config.js";
import type { SessionRecord } from "../../src/monitor/types.js";

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
  language: "en",
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: "macbook:s1",
    sessionId: "s1",
    agentType: "codex",
    hostname: null,
    project: "MyRepo",
    workspace: null,
    transcriptPath: null,
    status: "ACTIVE",
    startedAtMs: T0,
    updatedAtMs: T0,
    lastActivityMs: T0,
    turnStartedMs: null,
    lastHeartbeatMs: null,
    lastStage: null,
    lastMessage: null,
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    lastArtifacts: null,
    ...overrides,
  };
}

const quiet = {
  hostAvailable: true,
  processActive: false,
  transcriptActive: false,
};

describe("evaluateSessionTick", () => {
  it("ACTIVE -> QUIET after the quiet window", () => {
    const result = evaluateSessionTick(
      { session: session(), ...quiet },
      config,
      T0 + 601_000,
    );
    expect(result.updates.status).toBe("QUIET");
    expect(result.notifications.filter((n) => n.kind === "possible_stall")).toHaveLength(0);
  });

  it("QUIET -> stall once when host is available", () => {
    const result = evaluateSessionTick(
      { session: session({ status: "QUIET", lastActivityMs: T0 }), ...quiet },
      config,
      T0 + 1501_000,
    );
    expect(result.updates.status).toBe("UNKNOWN");
    const stall = result.notifications.find((n) => n.kind === "possible_stall");
    expect(stall).toBeDefined();
    expect(stall?.level).toBe("timeSensitive");
    expect(stall?.body).toContain("No observable activity");
  });

  it("no stall while the host is unreachable (sleep is not agent failure)", () => {
    const result = evaluateSessionTick(
      { session: session({ status: "QUIET" }), hostAvailable: false, processActive: false, transcriptActive: false },
      config,
      T0 + 12 * 3600_000,
    );
    expect(result.notifications).toHaveLength(0);
    expect(result.updates.status).toBeUndefined();
  });

  it("activity while QUIET resumes with one low-priority notification", () => {
    const result = evaluateSessionTick(
      { session: session({ status: "QUIET", lastActivityMs: T0 - 700_000 }), hostAvailable: true, processActive: false, transcriptActive: true },
      config,
      T0,
    );
    expect(result.updates.status).toBe("ACTIVE");
    const resumed = result.notifications.find((n) => n.kind === "resumed");
    expect(resumed?.level).toBe("passive");
    expect(result.clearedDedupKinds).toContain("possible_stall");
  });

  it("a re-baselined quiet episode resumes without a notification", () => {
    // Wake and restart set lastActivityMs = now together with status = QUIET, so
    // the next tick sees activity right away; "quiet for 0 min" would be noise.
    const result = evaluateSessionTick(
      { session: session({ status: "QUIET", lastActivityMs: T0 - 20_000 }), hostAvailable: true, processActive: false, transcriptActive: true },
      config,
      T0,
    );
    expect(result.updates.status).toBe("ACTIVE");
    expect(result.notifications).toHaveLength(0);
    expect(result.clearedDedupKinds).toContain("resumed");
  });

  it("STARTED becomes ACTIVE on first observed activity", () => {
    const result = evaluateSessionTick(
      { session: session({ status: "STARTED" }), hostAvailable: true, processActive: true, transcriptActive: false },
      config,
      T0 + 60_000,
    );
    expect(result.updates.status).toBe("ACTIVE");
    expect(result.notifications.filter((n) => n.kind === "resumed")).toHaveLength(0);
  });

  it("activity while WAITING_USER returns to ACTIVE and clears waiting dedup", () => {
    const result = evaluateSessionTick(
      { session: session({ status: "WAITING_USER" }), hostAvailable: true, processActive: true, transcriptActive: false },
      config,
      T0 + 60_000,
    );
    expect(result.updates.status).toBe("ACTIVE");
    expect(result.clearedDedupKinds).toContain("waiting");
  });

  it("terminal sessions are frozen", () => {
    for (const status of ["COMPLETED", "FAILED"] as const) {
      const result = evaluateSessionTick(
        { session: session({ status }), hostAvailable: true, processActive: true, transcriptActive: true },
        config,
        T0 + 10 * 3600_000,
      );
      expect(result.notifications).toHaveLength(0);
      expect(result.updates).toEqual({});
    }
  });

  it("first heartbeat fires at the initial interval, not before", () => {
    const early = evaluateSessionTick(
      { session: session(), ...quiet, processActive: true },
      config,
      T0 + 899_000,
    );
    expect(early.notifications.filter((n) => n.kind === "heartbeat")).toHaveLength(0);

    const due = evaluateSessionTick(
      { session: session(), ...quiet, processActive: true },
      config,
      T0 + 901_000,
    );
    const beat = due.notifications.find((n) => n.kind === "heartbeat");
    expect(beat?.level).toBe("passive");
    expect(beat?.body).toContain("Running 15 min");
    expect(due.updates.lastHeartbeatMs).toBe(T0 + 901_000);
  });

  it("subsequent heartbeats use the normal interval and skip unchanged sessions", () => {
    const lastBeat = T0 - 1801_000;
    const result = evaluateSessionTick(
      {
        session: session({ lastHeartbeatMs: lastBeat, lastActivityMs: T0 - 2000_000 }),
        ...quiet,
        processActive: true,
      },
      config,
      T0,
    );
    // due by interval, but nothing changed since the last beat
    expect(result.notifications.filter((n) => n.kind === "heartbeat")).toHaveLength(0);

    const changed = evaluateSessionTick(
      {
        session: session({ lastHeartbeatMs: lastBeat, lastActivityMs: T0 - 1000_000 }),
        ...quiet,
        processActive: true,
      },
      config,
      T0,
    );
    expect(changed.notifications.filter((n) => n.kind === "heartbeat")).toHaveLength(1);
  });

  it("no heartbeats while the host is unavailable", () => {
    const result = evaluateSessionTick(
      { session: session(), hostAvailable: false, processActive: false, transcriptActive: false },
      config,
      T0 + 10 * 3600_000,
    );
    expect(result.notifications).toHaveLength(0);
  });

  it("formatElapsed renders minutes and hours", () => {
    expect(formatElapsed(5 * 60_000)).toBe("5 min");
    expect(formatElapsed(90 * 60_000)).toBe("1h 30m");
  });
});

describe("notification readability", () => {
  const zh: MonitorConfig = { ...config, language: "zh" };

  function stall(cfg: MonitorConfig, overrides: Partial<SessionRecord> = {}) {
    const result = evaluateSessionTick(
      {
        session: session({ status: "QUIET", lastActivityMs: T0, ...overrides }),
        ...quiet,
      },
      cfg,
      T0 + 1501_000,
    );
    return result.notifications.find((n) => n.kind === "possible_stall");
  }

  it("titles state changes as Agent · Project · State", () => {
    expect(stall(config, { agentType: "claude-code" })?.title).toBe(
      "Claude Code · MyRepo · Possible Stall",
    );
    expect(stall(zh)?.title).toBe("Codex · MyRepo · 疑似卡住");
  });

  it("labels an unnamed session instead of showing a raw id", () => {
    const opaque = "62211ad1-730a-4de1-ae17-8ed9c4fd19a4";
    expect(stall(config, { project: null, sessionId: opaque })?.title).toBe(
      "Codex · session 62211ad1 · Possible Stall",
    );
  });

  it("keeps the stall body to one sentence plus context", () => {
    expect(stall(config)?.body).toBe("No observable activity for 25 min.");
    expect(stall(zh)?.body).toBe("已 25 分钟没有任何可观察动作");
  });

  it("appends diffstat, stage and artifacts as context lines", () => {
    const withContext = stall(config, {
      changedFiles: 44,
      insertions: 1208,
      deletions: 15,
      lastStage: "running the test suite",
      lastArtifacts: "dist/cli/index.js",
    });
    expect(withContext?.body).toBe(
      [
        "No observable activity for 25 min.",
        "44 files changed +1208 −15",
        "Stage: running the test suite",
        "Artifacts: dist/cli/index.js",
      ].join("\n"),
    );
    expect(stall(zh, { changedFiles: 3, insertions: 10, lastStage: "跑测试" })?.body)
      .toBe(["已 25 分钟没有任何可观察动作", "3 文件改动 +10 −0", "阶段: 跑测试"].join("\n"));
  });

  it("renders the heartbeat digest without duplicated units", () => {
    const zhBeat = evaluateSessionTick(
      {
        session: session({ lastActivityMs: T0 + 900_000 }),
        ...quiet,
      },
      zh,
      T0 + 901_000,
    ).notifications.find((n) => n.kind === "heartbeat");
    expect(zhBeat?.title).toBe("Codex · MyRepo · 还在跑");
    expect(zhBeat?.body).toBe("已跑 15 分钟 · 最近动作在不到 1 分钟前");

    const enBeat = evaluateSessionTick(
      {
        session: session({ lastActivityMs: T0 + 900_000 }),
        ...quiet,
      },
      config,
      T0 + 901_000,
    ).notifications.find((n) => n.kind === "heartbeat");
    expect(enBeat?.body).toBe("Running 15 min\nLast activity 0 min ago");
  });
});
