import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor, maskSecret, validateDoctorConfig } from "../../src/cli/index.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readFileSync: vi.fn(() => { throw new Error("No dotenv in doctor tests"); }),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

describe("doctor helpers", () => {
  it("masks secrets", () => {
    expect(maskSecret("https://api.day.app/abcdef123456")).toBe("https://api.day.app/[REDACTED]");
  });

  it("reports missing Bark config by default", () => {
    const result = validateDoctorConfig({});
    expect(result.ok).toBe(false);
    expect(result.messages).toContain("Missing AGENT_NOTIFY_TOKENS");
    expect(result.messages).toContain("Missing BARK_ENDPOINT");
  });

  it("reports missing ntfy endpoint when ntfy provider is selected", () => {
    const result = validateDoctorConfig({
      AGENT_NOTIFY_TOKENS: "macbook:abc",
      AGENT_NOTIFY_PROVIDER: "ntfy",
    });
    expect(result.ok).toBe(false);
    expect(result.messages).toContain("Missing NTFY_ENDPOINT");
    expect(result.messages).not.toContain("Missing BARK_ENDPOINT");
  });

  it("accepts ntfy doctor config without Bark endpoint", () => {
    const result = validateDoctorConfig({
      AGENT_NOTIFY_TOKENS: "macbook:abc",
      AGENT_NOTIFY_PROVIDER: "ntfy",
      NTFY_ENDPOINT: "https://ntfy.sh/agent_notify_xxx",
    });
    expect(result.ok).toBe(true);
    expect(result.messages).toEqual([]);
  });
});

describe("doctor diagnostics", () => {
  const nowMs = 1_800_000_000_000;
  const originalEnv = process.env;
  let previousExitCode: typeof process.exitCode;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let output: string[];

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const host = (overrides: Record<string, unknown> = {}) => ({
    hostname: "test-mac",
    status: "HOST_AVAILABLE",
    lastHeartbeatMs: nowMs - 10_000,
    ...overrides,
  });
  const respond = (hosts: unknown[]) => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    fetchMock.mockResolvedValueOnce(json({ ok: true, hosts }));
  };
  const text = () => output.join("\n");

  beforeEach(() => {
    process.env = {
      AGENT_NOTIFY_TOKENS: "test:secret-token",
      BARK_ENDPOINT: "https://api.day.app/secret-endpoint",
      AGENT_NOTIFY_LOG_PATH: "/tmp/herald-doctor-test/events.jsonl",
    };
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    output = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  });

  afterEach(() => {
    process.env = originalEnv;
    process.exitCode = previousExitCode;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("reports a fresh available bridge and checks log directory write access", async () => {
    respond([host()]);

    await doctor();

    expect(text()).toContain("OK server health reachable");
    expect(text()).toContain("OK host bridge #1: HOST_AVAILABLE, heartbeat age=10s (timeout=180s)");
    expect(text()).not.toContain("secret-token");
    expect(text()).not.toContain("secret-endpoint");
    expect(process.exitCode).toBeUndefined();
    expect(access).toHaveBeenCalledWith("/tmp/herald-doctor-test", constants.W_OK);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8787/health",
      "http://127.0.0.1:8787/status",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns when no host bridge has reported", async () => {
    respond([]);

    await doctor();

    expect(text()).toContain("WARN no host bridge heartbeat yet — run ./herald install-host on the Mac");
    expect(text()).not.toContain("OK host bridge");
    expect(process.exitCode).toBeUndefined();
  });

  it("warns when a host has no heartbeat", async () => {
    respond([host({ lastHeartbeatMs: null })]);

    await doctor();

    expect(text()).toContain("WARN host bridge #1: no heartbeat received");
    expect(text()).not.toContain("OK host bridge");
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    [59_999, false],
    [60_000, true],
    [60_001, true],
  ])("uses the configured timeout for a persisted available host aged %ims", async (ageMs, stale) => {
    process.env.HERALD_HOST_HEARTBEAT_TIMEOUT_SECONDS = "60";
    respond([host({ lastHeartbeatMs: nowMs - ageMs })]);

    await doctor();

    expect(text()).toContain(stale ? "WARN host bridge #1: heartbeat stale" : "OK host bridge #1: HOST_AVAILABLE");
    expect(text()).toContain("timeout=60s");
    expect(text().includes("OK host bridge")).toBe(!stale);
    expect(process.exitCode).toBeUndefined();
  });

  it("warns for an unreachable host even when its heartbeat is fresh", async () => {
    respond([host({ status: "HOST_UNREACHABLE" })]);

    await doctor();

    expect(text()).toContain("WARN host bridge #1: HOST_UNREACHABLE, heartbeat age=10s");
    expect(text()).not.toContain("OK host bridge");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports each host without a blanket bridge success", async () => {
    respond([host(), host({ status: "HOST_UNREACHABLE" }), host({ lastHeartbeatMs: null })]);

    await doctor();

    expect(text()).toContain("OK host bridge #1: HOST_AVAILABLE");
    expect(text()).toContain("WARN host bridge #2: HOST_UNREACHABLE");
    expect(text()).toContain("WARN host bridge #3: no heartbeat received");
  });

  it("skips monitor status and bridge diagnostics when monitoring is disabled", async () => {
    process.env.HERALD_ENABLED = "false";
    fetchMock.mockResolvedValueOnce(json({ ok: true }));

    await doctor();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text()).toContain("OK server health reachable");
    expect(text()).not.toContain("host bridge");
    expect(text()).not.toContain("monitor status");
    expect(text()).not.toContain("Codex approval alerts");
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    null,
    [],
    { ok: false, hosts: [] },
    { ok: true },
    { ok: true, hosts: null },
    { ok: true, hosts: [null] },
    { ok: true, hosts: [host({ status: "unknown secret-token" })] },
    { ok: true, hosts: [host({ lastHeartbeatMs: "secret-token" })] },
    { ok: true, hosts: [{ status: "HOST_AVAILABLE" }] },
    { ok: true, hosts: [host({ lastHeartbeatMs: -1 })] },
  ])("fails safely on malformed status response %j", async (body) => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    fetchMock.mockResolvedValueOnce(json(body));

    await doctor();

    expect(text()).toContain("FAIL monitor status invalid response");
    expect(text()).not.toContain("secret-token");
    expect(text()).not.toContain("OK host bridge");
    expect(process.exitCode).toBe(1);
  });

  it.each(["/health", "/status"])("fails safely on HTTP errors from %s", async (path) => {
    if (path === "/status") fetchMock.mockResolvedValueOnce(json({ ok: true }));
    fetchMock.mockResolvedValueOnce(new Response("secret-token secret-endpoint", { status: 503 }));

    await doctor();

    expect(text()).toContain("HTTP 503");
    expect(text()).toContain(path === "/health" ? "FAIL server health unavailable" : "FAIL monitor status unavailable");
    expect(text()).not.toContain("secret-token");
    expect(text()).not.toContain("secret-endpoint");
    expect(process.exitCode).toBe(1);
    expect(fetchMock.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["/health", "/status"])("fails safely on invalid JSON from %s", async (path) => {
    if (path === "/status") fetchMock.mockResolvedValueOnce(json({ ok: true }));
    fetchMock.mockResolvedValueOnce(new Response("secret-token is not JSON"));

    await doctor();

    expect(text()).toContain("invalid JSON response");
    expect(text()).not.toContain("secret-token");
    expect(process.exitCode).toBe(1);
  });

  it.each(["/health", "/status"])("fails safely on network errors from %s", async (path) => {
    if (path === "/status") fetchMock.mockResolvedValueOnce(json({ ok: true }));
    fetchMock.mockRejectedValueOnce(new Error("connection rejected with secret-token secret-endpoint"));

    await doctor();

    expect(text()).toContain("request failed");
    expect(text()).not.toContain("secret-token");
    expect(text()).not.toContain("secret-endpoint");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["/health", "headers"],
    ["/health", "body"],
    ["/status", "headers"],
    ["/status", "body"],
  ])("bounds %s when response %s never arrive", async (path, phase) => {
    if (path === "/status") fetchMock.mockResolvedValueOnce(json({ ok: true }));
    if (phase === "headers") {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
    } else {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => new Promise<unknown>(() => {}),
      } as Response);
    }

    const running = doctor();
    await vi.advanceTimersByTimeAsync(0);
    const signal = fetchMock.mock.calls.at(-1)?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(text()).not.toContain("timed out");
    await vi.advanceTimersByTimeAsync(1);
    await running;

    expect(signal?.aborted).toBe(true);
    expect(text()).toContain("request timed out after 5s");
    expect(process.exitCode).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails on a health payload that does not confirm health", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "secret-token" }));

    await doctor();

    expect(text()).toContain("FAIL server health unavailable");
    expect(text()).toContain("invalid response");
    expect(text()).not.toContain("secret-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
