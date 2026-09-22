import { describe, expect, it } from "vitest";
import {
  composeTitle,
  digestLine,
  formatDuration,
  isOpaqueId,
  readableProject,
  shortId,
  stateLabel,
} from "../../src/core/notification-text.js";

const MINUTE = 60_000;

describe("notification text helpers", () => {
  it("recognises opaque ids and shortens them consistently", () => {
    expect(isOpaqueId("b537d940d7d3c66f5e1ad0ca")).toBe(true);
    expect(isOpaqueId("62211ad1-730a-4de1-ae17-8ed9c4fd19a4")).toBe(true);
    expect(isOpaqueId("codex-bark-monitor")).toBe(false);
    expect(isOpaqueId("my project")).toBe(false);
    expect(shortId("62211ad1-730a-4de1-ae17-8ed9c4fd19a4")).toBe("62211ad1");
  });

  it("labels an unnamed workspace instead of printing a bare hash", () => {
    expect(readableProject("agent-notify", "en")).toBe("agent-notify");
    expect(readableProject("b537d940d7d3c66f5e1ad0ca", "en")).toBe(
      "session b537d940",
    );
    expect(readableProject("b537d940d7d3c66f5e1ad0ca", "zh")).toBe(
      "会话 b537d940",
    );
    expect(readableProject("  ", "zh")).toBeUndefined();
    expect(readableProject(null, "en")).toBeUndefined();
  });

  it("joins title parts and drops the empty ones", () => {
    expect(composeTitle(["Codex", "Repo A", "Need Input"])).toBe(
      "Codex · Repo A · Need Input",
    );
    expect(composeTitle(["Codex", null, undefined, "Failed"])).toBe(
      "Codex · Failed",
    );
    expect(composeTitle(["", "  "])).toBe("");
  });

  it("formats durations per language", () => {
    expect(formatDuration(45_000, "en")).toBe("0 min");
    expect(formatDuration(15 * MINUTE, "en")).toBe("15 min");
    expect(formatDuration(65 * MINUTE, "en")).toBe("1h 5m");
    expect(formatDuration(45_000, "zh")).toBe("不到 1 分钟");
    expect(formatDuration(15 * MINUTE, "zh")).toBe("15 分钟");
    expect(formatDuration(75 * MINUTE, "zh")).toBe("1 小时 15 分");
  });

  it("localizes state labels and keeps unknown kinds verbatim", () => {
    expect(stateLabel("waiting", "en")).toBe("Need Input");
    expect(stateLabel("waiting", "zh")).toBe("等你输入");
    expect(stateLabel("heartbeat", "zh")).toBe("还在跑");
    expect(stateLabel("something_new", "zh")).toBe("something_new");
  });
});

describe("digestLine", () => {
  it("omits clocks too young to carry information", () => {
    expect(digestLine({ runningMs: 3_000 }, "en")).toBeUndefined();
    expect(digestLine({ runningMs: 3_000 }, "zh")).toBeUndefined();
    expect(digestLine({}, "en")).toBeUndefined();
    expect(digestLine({ runningMs: 72 * MINUTE }, "en")).toBe("task running 1h 12m");
    expect(digestLine({ turnMs: 40_000, runningMs: 72 * MINUTE }, "zh")).toBe(
      "任务已跑 1 小时 12 分",
    );
  });

  it("leads with the turn the push is about", () => {
    expect(digestLine({ turnMs: 12 * MINUTE, runningMs: 72 * MINUTE }, "en")).toBe(
      "this turn 12 min · task running 1h 12m",
    );
    expect(digestLine({ turnMs: 12 * MINUTE, runningMs: 72 * MINUTE }, "zh")).toBe(
      "本轮用时 12 分钟 · 任务已跑 1 小时 12 分",
    );
  });

  it("drops a clock that only repeats the task total", () => {
    // First turn of a session: "this turn" and "task running" are the same number.
    expect(
      digestLine({ turnMs: 72 * MINUTE, runningMs: 72 * MINUTE + 30_000 }, "en"),
    ).toBe("task running 1h 12m");
    // A session that has never done anything since it started.
    expect(
      digestLine({ runningMs: 15 * MINUTE, idleMs: 15 * MINUTE }, "en"),
    ).toBe("task running 15 min");
  });

  it("combines elapsed time with the diffstat", () => {
    expect(
      digestLine(
        { turnMs: 12 * MINUTE, runningMs: 72 * MINUTE, changedFiles: 44, insertions: 1208, deletions: 15 },
        "zh",
      ),
    ).toBe("本轮用时 12 分钟 · 任务已跑 1 小时 12 分 · 44 文件改动 +1208 −15");
    expect(
      digestLine({ changedFiles: 3, insertions: 10, deletions: 0 }, "zh"),
    ).toBe("3 文件改动 +10 −0");
  });

  it("drops the diffstat suffix when nothing was counted", () => {
    expect(digestLine({ changedFiles: 2 }, "en")).toBe("2 files changed");
    expect(digestLine({ changedFiles: 0, insertions: 90 }, "en")).toBeUndefined();
  });

  it("reports idleness for stalled sessions", () => {
    expect(digestLine({ idleMs: 25 * MINUTE }, "zh")).toBe("25 分钟没动静");
  });
});
