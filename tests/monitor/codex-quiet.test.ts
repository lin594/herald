import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { parseMonitorConfig } from "../../src/monitor/config.js";
import { openDatabase } from "../../src/monitor/db.js";
import { MonitorStore } from "../../src/monitor/store.js";
import { MonitorNotifier } from "../../src/monitor/notifier.js";
import { MonitorScheduler } from "../../src/monitor/scheduler.js";
import { MonitorHub } from "../../src/monitor/hub.js";
import { evaluateSessionTick } from "../../src/monitor/statemachine.js";
import { classifyTranscriptTail, latestCodexProgress } from "../../src/monitor/observers.js";
import type { NotificationPayload } from "../../src/providers/types.js";
import { handleCodexEvent, parseCodexConfig } from "../../examples/codex/codex-agent-notify.mjs";

const T0 = 1_700_000_000_000;
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); vi.useRealTimers(); });
function fixture(env: NodeJS.ProcessEnv = {}, threshold = 120) {
  const config = parseMonitorConfig({ HERALD_DB_PATH: ":memory:", ...env });
  const db = openDatabase(":memory:");
  closes.push(() => db.close());
  const store = new MonitorStore(db);
  const sent: NotificationPayload[] = [];
  const provider = { name: "mock", send: vi.fn(async (p: NotificationPayload) => { sent.push(p); return { ok: true }; }) };
  const notifier = new MonitorNotifier(store, provider, config);
  const scheduler = new MonitorScheduler(store, notifier, config);
  const hub = new MonitorHub({ store, notifier, scheduler, config, tokens: [{ name: "mac", value: "token" }], completionMinSeconds: threshold });
  const hook = (name: string, at: number, extra: Record<string, unknown> = {}) => hub.handleIncoming({ agent: "codex", raw: { hook_event_name: name, session_id: "thread", cwd: "/work/herald", ...extra } }, "mac", at);
  return { config, db, store, sent, provider, notifier, scheduler, hub, hook };
}

describe("Codex quiet Bark policy", () => {
  it("records 100 approve-for-me requests without claiming a human is needed, even at zero grace", async () => {
    const f = fixture({ HERALD_WAITING_GRACE_SECONDS: "0" });
    await f.hook("UserPromptSubmit", T0);
    for (let i = 1; i <= 100; i++) await f.hook("PermissionRequest", T0 + i, { tool_name: "Bash" });
    await f.scheduler.run(T0 + 90_000);
    expect(f.sent).toHaveLength(0);
    expect(f.store.getSession("mac:thread")?.status).toBe("ACTIVE");
    expect(f.store.recentEvents(200)).toHaveLength(101);
  });

  it("does not replay legacy or disabled approval timers after an upgrade", async () => {
    for (const waitingKind of [null, "approval"] as const) {
      const f = fixture();
      await f.hook("UserPromptSubmit", T0);
      f.store.updateSession("mac:thread", { status: "WAITING_USER", waitingSinceMs: T0, waitingOn: "Bash", waitingKind });
      await f.scheduler.run(T0 + 120_000);
      expect(f.sent).toHaveLength(0);
      expect(f.store.getSession("mac:thread")).toMatchObject({ status: "UNKNOWN", waitingSinceMs: null, waitingOn: null });
    }
  });

  it("a resolved manual approval stays quiet; duplicate request hooks do not rearm it", async () => {
    const f = fixture({ HERALD_CODEX_APPROVAL_ALERTS: "true" });
    await f.hook("UserPromptSubmit", T0);
    await f.hook("PermissionRequest", T0 + 1000, { tool_name: "Bash", tool_use_id: "call" });
    await f.hook("PermissionRequest", T0 + 2000, { tool_name: "Bash", tool_use_id: "call" });
    expect(f.store.getSession("mac:thread")?.waitingSinceMs).toBe(T0 + 1000);
    await f.hook("PostToolUse", T0 + 3000, { tool_name: "Bash", tool_use_id: "call" });
    await f.scheduler.run(T0 + 70_000);
    expect(f.sent).toHaveLength(0);
    expect(f.store.getSession("mac:thread")?.waitingSinceMs).toBeNull();
  });

  it("a blocking question alerts once and unrelated progress cannot answer it", async () => {
    const f = fixture({ AGENT_NOTIFY_LANGUAGE: "zh" });
    await f.hook("UserPromptSubmit", T0);
    await f.hook("PreToolUse", T0 + 1000, { tool_name: "request_user_input", tool_use_id: "question", tool_input: { questions: [{ question: "选择哪个部署环境？" }] } });
    await f.hook("PostToolUse", T0 + 2000, { tool_name: "Bash", tool_use_id: "parallel" });
    f.scheduler.recordObservation({ sessionId: "thread", atMs: T0 + 62_000, processCount: 1 });
    await f.scheduler.run(T0 + 62_000);
    await f.scheduler.run(T0 + 80_000);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].title).toContain("等你输入");
    expect(f.sent[0].body).toBe("请回到电脑，在 Codex 中选择或填写。\n选择哪个部署环境？");
    expect(f.sent[0].level).toBe("timeSensitive");
    await f.hook("PostToolUse", T0 + 90_000, { tool_use_id: "question" });
    expect(f.store.getSession("mac:thread")?.status).toBe("ACTIVE");
  });

  it("routine milestones do not page the user", async () => {
    const f = fixture();
    await f.hook("UserPromptSubmit", T0);
    await f.hub.handleIncoming({ agent: "emit", raw: { type: "milestone", message: "one file saved", session_id: "thread", agent_type: "codex" } }, "mac", T0 + 2000);
    await f.notifier.notify("mac:thread", { kind: "resumed", title: "Resumed", body: "more activity" }, T0 + 3000);
    expect(f.sent).toHaveLength(0);
    expect(f.store.getSession("mac:thread")?.status).toBe("ACTIVE");
  });

  it("async choices alert once with the action and options, even while other tools continue", async () => {
    const f = fixture({ AGENT_NOTIFY_LANGUAGE: "zh" });
    await f.hook("UserPromptSubmit", T0);
    const question = { tool_name: "functions.request_user_input_async", tool_use_id: "q1", tool_input: { questions: [{ title: "演示库每次上线要如何处理？", options: ["保留数据，冲突时停止", "备份后重建"] }] } };
    await f.hook("PreToolUse", T0 + 1000, question);
    await f.hook("PostToolUse", T0 + 2000, question);
    await f.hook("PostToolUse", T0 + 3000, { tool_name: "Bash", tool_use_id: "parallel" });
    await f.scheduler.run(T0 + 59_000);
    expect(f.sent).toHaveLength(0);
    await f.scheduler.run(T0 + 62_000);
    await f.hook("PostToolUse", T0 + 70_000, question);
    await f.scheduler.run(T0 + 80_000);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ title: "Codex · herald · 有问题等你回答", body: "请回到电脑，在 Codex 中选择或填写。\n演示库每次上线要如何处理？\n选项：保留数据，冲突时停止 / 备份后重建", level: "timeSensitive" });
    expect(f.store.getSession("mac:thread")).toMatchObject({ status: "ACTIVE", waitingKind: "input_async", waitingSinceMs: T0 + 1000 });
    await f.hook("UserPromptSubmit", T0 + 90_000);
    expect(f.store.getSession("mac:thread")?.waitingSinceMs).toBeNull();
  });

  it("recovers an async question from PostToolUse alone and prioritizes it over turn completion", async () => {
    const f = fixture({ AGENT_NOTIFY_LANGUAGE: "zh" });
    await f.hook("UserPromptSubmit", T0);
    await f.hook("PostToolUse", T0 + 1000, { tool_name: "request_user_input_async", tool_use_id: "q1", tool_input: { questions: [{ title: "请在电脑上的登录页登录，完成后回复已登录。" }] } });
    await f.hook("Stop", T0 + 121_000, { turn_id: "t1", last_assistant_message: "准备已完成，等待登录。" });
    expect(f.sent).toHaveLength(0);
    await f.scheduler.run(T0 + 130_000);
    await f.scheduler.run(T0 + 1900_000);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].body).toContain("请在电脑上的登录页登录");
    expect(f.sent[0].title).toContain("有问题等你回答");
    expect(f.store.getSession("mac:thread")?.waitingKind).toBe("input_async");
  });

  it("still asks the user to return to Codex when an older hook supplies no question text", async () => {
    const f = fixture({ AGENT_NOTIFY_LANGUAGE: "zh" });
    await f.hook("UserPromptSubmit", T0);
    await f.hook("PostToolUse", T0 + 1000, { tool_name: "request_user_input_async", tool_use_id: "q1" });
    await f.scheduler.run(T0 + 62_000);
    expect(f.sent[0]?.body).toBe("请回到电脑，在 Codex 中选择或填写。");
  });

  it("a quick answer clears an async prompt before the grace elapses", async () => {
    const f = fixture();
    await f.hook("UserPromptSubmit", T0);
    await f.hook("PostToolUse", T0 + 1000, { tool_name: "request_user_input_async", tool_use_id: "q1", tool_input: { questions: [{ title: "Choose A or B", options: ["A", "B"] }] } });
    await f.hook("UserPromptSubmit", T0 + 20_000);
    await f.scheduler.run(T0 + 62_000);
    expect(f.sent).toHaveLength(0);
  });

  it("a delayed async tool hook after interrupt cannot recreate a cancelled question", async () => {
    const f = fixture();
    await f.hook("UserPromptSubmit", T0);
    await f.hook("Interrupt", T0 + 1000);
    await f.hook("PostToolUse", T0 + 2000, { tool_name: "request_user_input_async", tool_use_id: "q1", tool_input: { questions: [{ title: "Stale question" }] } });
    await f.scheduler.run(T0 + 62_000);
    expect(f.sent).toHaveLength(0);
    expect(f.store.getSession("mac:thread")?.waitingSinceMs).toBeNull();
  });

  it("delivers an async question through the real adapter and authenticated HTTP path", async () => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    const f = fixture({ AGENT_NOTIFY_LANGUAGE: "zh" });
    await f.hook("UserPromptSubmit", T0);
    const app = createApp({ tokens: [{ name: "mac", value: "token" }], provider: f.provider, logPath: "./data/async-test.jsonl", logRaw: false, language: "zh", claudeCompletionMinSeconds: 120, codexCompletionMinSeconds: 120, opencodeCompletionMinSeconds: 120, cooldownSeconds: 60, monitor: f.hub });
    const result = await handleCodexEvent(parseCodexConfig({ serverUrl: "http://herald", token: "token" }), {
      hook_event_name: "PostToolUse", session_id: "thread", tool_name: "request_user_input_async", tool_use_id: "q1",
      tool_input: { questions: [{ title: "发布到哪里？", options: ["预发布", "生产"] }], private: "never forward" },
      tool_response: { accepted: true, private: "never forward" },
    }, { readState: () => ({ persistentDisabled: false, disabledSessions: {} }), fetchImpl: async (_url, init) => app.request("/events", init) });
    expect(result.sent).toBe(true);
    await f.scheduler.run(T0 + 61_000);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ body: "请回到电脑，在 Codex 中选择或填写。\n发布到哪里？\n选项：预发布 / 生产", id: expect.any(String), level: "timeSensitive" });
    expect(JSON.stringify(f.store.recentEvents(5))).not.toContain("never forward");
  });

  it("only new progress earns another digest, and the first digest clock resets for each turn", async () => {
    const f = fixture({ AGENT_NOTIFY_LANGUAGE: "zh" });
    await f.hook("UserPromptSubmit", T0);
    f.store.updateSession("mac:thread", { lastMessage: "测试通过，正在检查部署配置。" });
    for (const t of [1800_000, 3600_000]) {
      f.scheduler.recordObservation({ sessionId: "thread", atMs: T0 + t, processCount: 1 });
      await f.scheduler.run(T0 + t);
    }
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].body).not.toContain("任务已跑");
    f.store.updateSession("mac:thread", { lastMessage: "部署配置已检查，正在做回归测试。" });
    f.scheduler.recordObservation({ sessionId: "thread", atMs: T0 + 5400_000, processCount: 1 });
    await f.scheduler.run(T0 + 5400_000);
    expect(f.sent).toHaveLength(2);
    await f.hook("UserPromptSubmit", T0 + 100 * 3600_000);
    await f.scheduler.run(T0 + 100 * 3600_000 + 120_000);
    expect(f.sent).toHaveLength(2);
  });

  it("completion uses ordinary delivery, concise text and turn dedup, including concurrent Stops", async () => {
    const f = fixture();
    await f.hook("UserPromptSubmit", T0);
    await Promise.all([f.hook("Stop", T0 + 121_000, { turn_id: "turn1", last_assistant_message: "Summary ".repeat(100) }), f.hook("Stop", T0 + 121_001, { turn_id: "turn1", last_assistant_message: "different formatting" })]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].level).toBe("active");
    expect(f.sent[0].body.length).toBeLessThan(220);
    expect(f.store.getSession("mac:thread")?.lastTurnMs).toBe(121_000);
    await f.hook("UserPromptSubmit", T0 + 200_000);
    await f.hook("Stop", T0 + 321_000, { turn_id: "turn2", last_assistant_message: "Summary" });
    expect(f.sent).toHaveLength(2);
  });

  it("short, disabled and stop-hook continuation turns stay quiet", async () => {
    for (const threshold of [120, 0]) {
      const f = fixture({}, threshold);
      await f.hook("UserPromptSubmit", T0);
      await f.hook("Stop", T0 + 300_000, { stop_hook_active: true });
      expect(f.store.getSession("mac:thread")?.turnStartedMs).toBe(T0);
      await f.hook("Stop", T0 + 10_000);
      expect(f.sent).toHaveLength(0);
    }
  });

  it("interrupt and session close clear waits without calling the task completed", async () => {
    for (const event of ["Interrupt", "SessionEnd"]) {
      const f = fixture();
      await f.hook("UserPromptSubmit", T0);
      await f.hook("PreToolUse", T0 + 1000, { tool_name: "request_user_input", tool_use_id: "question" });
      await f.hook(event, T0 + 2000);
      await f.scheduler.run(T0 + 1900_000);
      expect(f.sent).toHaveLength(0);
      expect(f.store.getSession("mac:thread")?.waitingSinceMs).toBeNull();
      expect(f.store.getSession("mac:thread")?.status).toBe("UNKNOWN");
    }
  });

  it("first digest is due at 30 minutes, is passive, and unchanged work is not repeated", async () => {
    const f = fixture();
    await f.hook("UserPromptSubmit", T0);
    f.store.updateSession("mac:thread", { lastMessage: "测试已经通过，正在检查部署配置。", lastActivityMs: T0 + 1700_000 });
    await f.scheduler.run(T0 + 1799_000);
    expect(f.sent).toHaveLength(0);
    await f.scheduler.run(T0 + 1800_000);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].body).toContain("测试已经通过");
    expect(f.sent[0].level).toBe("passive");
    const record = f.store.getSession("mac:thread")!;
    const result = evaluateSessionTick({ session: { ...record, lastActivityMs: record.lastHeartbeatMs! }, hostAvailable: true, processActive: false, transcriptActive: false, turnInFlight: true }, { ...f.config, stallSeconds: 10_000 }, T0 + 3600_000);
    expect(result.notifications.filter((n) => n.kind === "heartbeat")).toHaveLength(0);
  });

  it("HTTP ingestion cannot bypass the severity floor", async () => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    const f = fixture({ HERALD_MIN_SEVERITY: "critical" });
    const app = createApp({ tokens: [{ name: "mac", value: "token" }], provider: f.provider, logPath: "./data/quiet-test.jsonl", logRaw: false, language: "en", claudeCompletionMinSeconds: 120, codexCompletionMinSeconds: 120, opencodeCompletionMinSeconds: 120, cooldownSeconds: 60, monitor: f.hub });
    const post = (name: string) => app.request("/events", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ agent: "codex", raw: { hook_event_name: name, session_id: "thread" } }) });
    expect((await post("UserPromptSubmit")).status).toBe(200);
    vi.setSystemTime(T0 + 130_000);
    const stop = await post("Stop");
    expect(await stop.json()).toEqual({ ok: true, notified: false });
    expect(f.sent).toHaveLength(0);
  });
});

describe("public Codex progress", () => {
  const record = (payload: unknown, type = "response_item") => JSON.stringify({ timestamp: new Date(T0 + 1000).toISOString(), type, payload });
  it("reads desktop phase and CLI channel, excluding prompts, reasoning and tool outputs", () => {
    for (const fields of [{ phase: "commentary" }, { channel: "commentary" }]) {
      const progress = record({ type: "message", role: "assistant", ...fields, content: [{ type: "output_text", text: "Tests passed; checking the deployment." }] });
      const noise = [record({ type: "message", role: "user", content: [{ type: "text", text: "private prompt" }] }), record({ type: "reasoning", text: "private reasoning" }), record({ type: "function_call_output", output: "private stdout" })];
      expect(latestCodexProgress([progress, ...noise])?.message).toBe("Tests passed; checking the deployment.");
    }
  });
  it("does not reuse an old update after a new turn or completion, and recognizes interruption", () => {
    const progress = record({ type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "old update" }] });
    for (const kind of ["task_started", "task_complete", "turn_aborted"]) {
      const lines = [progress, record({ type: kind }, "event_msg")];
      expect(latestCodexProgress(lines)).toBeNull();
    }
    expect(classifyTranscriptTail([record({ type: "task_started" }, "event_msg"), record({ type: "turn_aborted" }, "event_msg")])).toBe("idle");
  });
});
