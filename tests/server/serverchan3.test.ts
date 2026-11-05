import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { ServerChan3Provider } from "../../src/providers/serverchan3.js";

const sendKey = "sctp123tfixture_secret";
const dirs: string[] = [];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network disabled in integration test")));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("ServerChan³ hook delivery with mocked transport", () => {
  it.each([true, false])("keeps SendKey out of hook responses, logs and push content (accepted=%s)", async (accepted) => {
    const dir = await mkdtemp(join(tmpdir(), "herald-sc3-"));
    dirs.push(dir);
    const logPath = join(dir, "events.jsonl");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: accepted ? 0 : 7, message: sendKey }), { status: 200 }));
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
    const app = createApp({
      tokens: [{ name: "fixture", value: "dummy" }],
      provider: new ServerChan3Provider(sendKey, fetchMock),
      logPath,
      logRaw: true,
      language: "en",
      claudeCompletionMinSeconds: 0,
      codexCompletionMinSeconds: 0,
      opencodeCompletionMinSeconds: 0,
      cooldownSeconds: 0,
    });
    const health = await app.request("/health");
    expect(await health.json()).toMatchObject({ ok: true, provider: "serverchan3" });
    const response = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: JSON.stringify({ agent: "opencode", raw: {
        id: "fixture-event", type: "permission.v2.asked", sendKey,
        diagnostic: `https://123.push.ft07.com/send/${sendKey}.send`,
        properties: { id: "fixture-permission", sessionID: "fixture-session", action: "bash", resources: [`echo SERVERCHAN3_SENDKEY=${sendKey}`] },
      } }),
    });
    expect(response.status).toBe(accepted ? 200 : 502);
    const responseBody = await response.text();
    const log = await readFile(logPath, "utf8");
    const requestBody = fetchMock.mock.calls[0][1]!.body as string;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(responseBody + log + requestBody + output.join("\n")).not.toContain(sendKey);
    expect(log).toContain(accepted ? '"status":"sent"' : '"status":"provider_failed"');
    if (!accepted) expect(responseBody).toContain("ServerChan³ rejected the notification");
  });
});
