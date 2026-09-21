import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  detectSleepGap,
  parseHostConfig,
  parseProcessList,
  scanActiveQoderSessionIds,
  scanActiveSessionIds,
  tickOnce,
} from "../../host/herald-host.mjs";

const UUID = "01a0ba70-3d09-73a0-892d-aa43c3a84a2e";
const QODER_UUID = "62211ad1-730a-4de1-ae17-8ed9c4fd19a4";
const T0 = Date.now();

describe("herald-host bridge", () => {
  it("parses required config and expands ~ paths", () => {
    const config = parseHostConfig({
      serverUrl: "http://127.0.0.1:8787/",
      token: "abc",
      codexSessionsDir: "~/.codex/sessions",
    });
    expect(config.serverUrl).toBe("http://127.0.0.1:8787");
    expect(config.intervalSeconds).toBe(30);
    expect(config.codexSessionsDir).not.toContain("~");
    expect(config.qoderProjectsDir).not.toContain("~");
    expect(() => parseHostConfig({ serverUrl: "http://x" })).toThrow(/token/);
  });

  it("classifies agent processes, skips resident daemons and itself", () => {
    const ps = [
      "  101 node /usr/local/bin/codex",
      "  202 /bin/zsh -c cargo build",
      "  303 node /repo/host/herald-host.mjs",
      "  404 claude --resume",
      "  505 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
      "  606 node /Users/me/workspace/lin594/herald/dist/server/index.js",
      "  707 codex exec fix the bug",
      "  808 node /usr/local/bin/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
      "  909 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/140/Codex Framework Helper (Plugin)",
      " 1010 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      " 1111 /Applications/Qoder.app/Contents/MacOS/Qoder",
      " 1212 qoder",
    ].join("\n");
    const procs = parseProcessList(ps) as { pid: number }[];
    expect(procs.map((p) => p.pid)).toEqual([101, 404, 707, 1212]);
  });

  it("detects sleep gaps beyond two intervals", () => {
    expect(detectSleepGap(T0, T0 + 31_000, 30)).toBeUndefined();
    expect(detectSleepGap(T0, T0 + 10 * 60_000, 30)).toBe(600);
    expect(detectSleepGap(null, T0, 30)).toBeUndefined();
  });

  it("finds recently-touched rollout uuids under YYYY/MM/DD", () => {
    const root = join(tmpdir(), `herald-sessions-${T0}`);
    const day = join(root, "2026", "09", "20");
    const oldDay = join(root, "2026", "08", "01");
    mkdirSync(day, { recursive: true });
    mkdirSync(oldDay, { recursive: true });
    const fresh = join(day, `rollout-2026-09-20T00-11-53-${UUID}.jsonl`);
    const stale = join(day, `rollout-2026-09-20T00-17-44-${"0".repeat(8)}-0000-0000-0000-000000000000.jsonl`);
    const noise = join(day, "not-a-rollout.txt");
    writeFileSync(fresh, "{}\n");
    writeFileSync(stale, "{}\n");
    writeFileSync(noise, "");
    const past = new Date((T0 - 10 * 60_000) / 1000);
    utimesSync(stale, past, past);
    expect(scanActiveSessionIds(root, T0)).toEqual([UUID]);
  });

  it("finds recently-touched Qoder session uuids under <project-slug>/", () => {
    const root = join(tmpdir(), `herald-qoder-${T0}`);
    const project = join(root, "-Users-me-workspace-lin594-my-repo");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${QODER_UUID}.jsonl`), "{}\n");
    const stale = join(project, "d775c7fb-8d1d-4c35-906c-71f3d0f4c47b.jsonl");
    writeFileSync(stale, "{}\n");
    writeFileSync(join(project, "segment-2026-09-20.jsonl"), "{}\n");
    const past = new Date((T0 - 10 * 60_000) / 1000);
    utimesSync(stale, past, past);
    expect(scanActiveQoderSessionIds(root, T0)).toEqual([QODER_UUID]);
    expect(scanActiveQoderSessionIds(join(root, "missing"), T0)).toEqual([]);
  });

  it("tickOnce posts heartbeat and observations with the sleep gap", async () => {
    const posts: { url: string; token: string; path: string; body: Record<string, unknown> }[] =
      [];
    const config = {
      serverUrl: "http://server",
      token: "tok",
      codexSessionsDir: "/unused",
      qoderProjectsDir: "/unused-qoder",
      intervalSeconds: 30,
    };
    const state = { lastTickMs: T0 - 3_600_000 };
    const result = await tickOnce(config, state, T0, {
      collectProcesses: async () => [{ pid: 1, command: "codex" }],
      scanActiveSessionIds: () => [UUID],
      scanActiveQoderSessionIds: () => [QODER_UUID],
      postJson: async (
        url: string,
        token: string,
        path: string,
        body: Record<string, unknown>,
      ) => {
        posts.push({ url, token, path, body });
        return true;
      },
    });
    expect(result.heartbeat).toBe(true);
    expect(posts.map((p) => p.path)).toEqual(["/host-heartbeat", "/observations"]);
    expect(posts[0].body.sleep_gap_seconds).toBe(3600);
    expect(posts[1].body.sessions).toEqual([
      { session_id: UUID, observed_at_ms: T0, processes: [{ pid: 1, command: "codex" }] },
      { session_id: QODER_UUID, observed_at_ms: T0, processes: [{ pid: 1, command: "codex" }] },
    ]);
    expect(posts[1].body.sleep_gap_seconds).toBe(3600);
  });
});
