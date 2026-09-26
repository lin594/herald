import { describe, expect, it } from "vitest";
import { evaluateSessionTick, formatElapsed } from "../../src/monitor/statemachine.js";
import {
  passesSeverityGate,
  resolveSeverity,
  SEVERITY_DELIVERY,
} from "../../src/monitor/severity.js";
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
  minSeverity: "info",
  severityMap: {},
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
    lastTurnMs: null,
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
      {
        session: session({ status: "QUIET", lastActivityMs: T0, turnStartedMs: T0 }),
        ...quiet,
        turnInFlight: true,
      },
      config,
      T0 + 1501_000,
    );
    expect(result.updates.status).toBe("UNKNOWN");
    const stall = result.notifications.find((n) => n.kind === "possible_stall");
    expect(stall).toBeDefined();
    // A stall is an inference, not a fact: it gets a visible push, but it must
    // never interrupt the way "the agent is waiting for you" does.
    expect(resolveSeverity(stall!, config)).toBe("notice");
    expect(stall?.body).toContain("No observable activity");
    // The clock the user acts on is the turn, not the whole task.
    expect(stall?.body).toContain("this turn 25 min");
  });

  it("downgrades a stall that nothing can back up to clock-only reporting", () => {
    const result = evaluateSessionTick(
      { session: session({ status: "QUIET", lastActivityMs: T0 }), ...quiet },
      config,
      T0 + 1501_000,
    );
    const stall = result.notifications.find((n) => n.kind === "possible_stall");
    expect(stall).toBeDefined();
    expect(resolveSeverity(stall!, config)).toBe("info");
    expect(stall?.body).toContain("by clock alone");
    expect(stall?.body).not.toContain("No observable activity");
  });

  it("HERALD_MIN_SEVERITY=notice drops the clock-only stall but keeps a real one", () => {
    const strict: MonitorConfig = { ...config, minSeverity: "notice" };
    const blind = evaluateSessionTick(
      { session: session({ status: "QUIET", lastActivityMs: T0 }), ...quiet },
      strict,
      T0 + 1501_000,
    );
    const backed = evaluateSessionTick(
      {
        session: session({ status: "QUIET", lastActivityMs: T0, turnStartedMs: T0 }),
        ...quiet,
        turnInFlight: true,
      },
      strict,
      T0 + 1501_000,
    );
    const blindStall = blind.notifications.find((n) => n.kind === "possible_stall");
    const backedStall = backed.notifications.find((n) => n.kind === "possible_stall");
    expect(passesSeverityGate(resolveSeverity(blindStall!, strict), strict)).toBe(false);
    expect(passesSeverityGate(resolveSeverity(backedStall!, strict), strict)).toBe(true);
  });

  it("HERALD_SEVERITY_MAP can move a kind up or down without a code change", () => {
    const mapped: MonitorConfig = {
      ...config,
      severityMap: { possible_stall: "critical", heartbeat: "debug" },
    };
    const result = evaluateSessionTick(
      { session: session({ status: "QUIET", lastActivityMs: T0 }), ...quiet },
      mapped,
      T0 + 1501_000,
    );
    const stall = result.notifications.find((n) => n.kind === "possible_stall");
    expect(SEVERITY_DELIVERY[resolveSeverity(stall!, mapped)]).toBe("timeSensitive");
    expect(
      passesSeverityGate(resolveSeverity({ kind: "heartbeat", title: "t", body: "b" }, mapped), mapped),
    ).toBe(false);
  });

  it("retires a finished session silently instead of reporting a stall", () => {
    // The transcript's last turn ended cleanly, so the silence means the task is
    // over — the user already heard about that from Stop, not a stall.
    const result = evaluateSessionTick(
      {
        session: session({ status: "QUIET", lastActivityMs: T0 }),
        ...quiet,
        turnInFlight: false,
      },
      config,
      T0 + 1501_000,
    );
    expect(result.updates.status).toBe("UNKNOWN");
    expect(result.notifications.filter((n) => n.kind === "possible_stall")).toHaveLength(0);
  });

  it("still stalls when the last turn never came back", () => {
    const result = evaluateSessionTick(
      {
        session: session({ status: "QUIET", lastActivityMs: T0 }),
        ...quiet,
        turnInFlight: true,
      },
      config,
      T0 + 1501_000,
    );
    expect(result.notifications.find((n) => n.kind === "possible_stall")).toBeDefined();
  });

  it("no transcript evidence leaves the clock in charge", () => {
    // null = transcript unreadable, undefined = no transcript at all (a
    // cooperative `emit` agent): both keep the pre-existing behaviour.
    for (const turnInFlight of [null, undefined]) {
      const result = evaluateSessionTick(
        {
          session: session({ status: "QUIET", lastActivityMs: T0 }),
          ...quiet,
          turnInFlight,
        },
        config,
        T0 + 1501_000,
      );
      expect(result.notifications.find((n) => n.kind === "possible_stall")).toBeDefined();
    }
  });

  it("a finished session gets no 'still running' heartbeat", () => {
    const run = (turnInFlight?: boolean) =>
      evaluateSessionTick(
        {
          session: session({ status: "ACTIVE", lastHeartbeatMs: null }),
          ...quiet,
          transcriptActive: true,
          turnInFlight,
        },
        config,
        T0 + 901_000,
      );
    expect(run()?.notifications.find((n) => n.kind === "heartbeat")).toBeDefined();
    expect(
      run(false).notifications.filter((n) => n.kind === "heartbeat"),
    ).toHaveLength(0);
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
    expect(resolveSeverity(resumed!, config)).toBe("info");
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
    expect(resolveSeverity(beat!, config)).toBe("info");
    expect(beat?.body).toContain("task running 15 min");
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
        // Readability is judged on the wording a *real* stall carries; the
        // clock-only variant is covered in the evaluateSessionTick block below.
        turnInFlight: true,
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
    expect(zhBeat?.body).toBe("任务已跑 15 分钟");

    const enBeat = evaluateSessionTick(
      {
        session: session({ lastActivityMs: T0 + 900_000 }),
        ...quiet,
      },
      config,
      T0 + 901_000,
    ).notifications.find((n) => n.kind === "heartbeat");
    expect(enBeat?.body).toBe("task running 15 min");
  });

  it("heartbeat reports the turn in flight separately from the task", () => {
    const beat = evaluateSessionTick(
      {
        session: session({
          lastActivityMs: T0 + 900_000,
          turnStartedMs: T0 + 300_000,
        }),
        ...quiet,
      },
      zh,
      T0 + 901_000,
    ).notifications.find((n) => n.kind === "heartbeat");
    expect(beat?.body).toBe("本轮用时 10 分钟 · 任务已跑 15 分钟");
  });
});
