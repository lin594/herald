import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import {
  classifyTranscriptTail,
  matchArtifacts,
  observeGit,
  observeWorkspace,
  scanQoderProjects,
  scanTranscriptDir,
  transcriptTurnEvidence,
  walkWorkspace,
} from "../../src/monitor/observers.js";

const UUID = "0f6f9a5a-2f1c-4b17-9a3d-1c2b3a4f5e6d";

describe("workspace observers", () => {
  const stamp = Date.now();
  const root = join(tmpdir(), `herald-ws-${stamp}`, "ws");
  const repo = join(tmpdir(), `herald-ws-${stamp}`, "gitrepo");

  beforeAll(() => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
    writeFileSync(join(root, "dist", "bundle.js"), "");

    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "tester"]);
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "untracked.txt"), "new file\n");
  });

  it("walks a workspace skipping ignored dirs, capped by maxFiles", async () => {
    const { signatures, truncated } = await walkWorkspace(root, 100);
    expect(truncated).toBe(false);
    const paths = [...signatures.keys()].sort();
    expect(paths).toEqual(["src/a.ts"]);

    const capped = await walkWorkspace(root, 0);
    expect(capped.truncated).toBe(true);
  });

  it("reports only files changed since the previous sweep", async () => {
    const workspace = { name: "ws", path: root, artifacts: [] };
    const state: { signatures: Map<string, number> | null } = { signatures: null };
    // first sweep seeds the baseline and reports nothing
    expect(await observeWorkspace(workspace, state)).toEqual({
      changedFiles: 0,
      changedPaths: [],
    });

    const future = new Date((Date.now() + 5000) / 1000);
    utimesSync(join(root, "src", "a.ts"), future, future);
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
    const delta = await observeWorkspace(workspace, state);
    expect(delta.changedPaths.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(delta.changedFiles).toBe(2);
  });

  it("matches artifacts by glob, returns basenames", () => {
    const paths = ["report.pdf", "dist/build/app.bin", "src/deep/nested/result.csv", "notes.md"];
    expect(matchArtifacts(paths, ["*.pdf", "**/result.csv", "*.pdf"])).toEqual([
      "report.pdf",
      "result.csv",
    ]);
    expect(matchArtifacts(paths, [])).toEqual([]);
    expect(matchArtifacts(["anything"], ["other.*"])).toEqual([]);
  });

  it("summarizes git state strictly read-only", async () => {
    const git = await observeGit(repo);
    expect(git).not.toBeNull();
    expect(git?.dirtyFiles).toBe(2); // modified tracked + untracked
    expect(git?.insertions).toBe(1);
    expect(git?.deletions).toBe(0);
    expect(git?.branch).toBeTruthy();

    // Still read-only afterwards: the dirty working tree was left untouched.
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], {
      encoding: "utf8",
    });
    expect(status).toContain("untracked.txt");
    const log = execFileSync("git", ["-C", repo, "log", "--oneline"], { encoding: "utf8" });
    expect(log.trim().split("\n")).toHaveLength(1); // nothing was committed

    expect(await observeGit(join(root, "not-a-repo"))).toBeNull();
  });

  it("indexes rollout transcripts under nested YYYY/MM/DD", async () => {
    const sessionsRoot = join(root, "..", `herald-sessions-${Date.now()}`);
    const day = join(sessionsRoot, "2026", "09", "20");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-09-20T10-00-00-${UUID}.jsonl`), "{}\n");
    writeFileSync(join(day, "README.txt"), "");
    const fresh = await scanTranscriptDir(sessionsRoot);
    expect([...fresh.keys()]).toEqual([UUID]);
    expect(fresh.get(UUID)?.size).toBeGreaterThan(0);

    expect(await scanTranscriptDir(join(sessionsRoot, "missing"))).toEqual(new Map());
  });

  it("indexes a resumed rollout under every id its name carries", async () => {
    // Codex continues a thread in `rollout-<ts>-<thread>_<turn>.jsonl` while the
    // hooks keep reporting the thread id, so keying only the trailing id left
    // resumed threads with no transcript to read — and a transcript-less session
    // is a session the monitor cannot prove idle.
    const sessionsRoot = join(root, "..", `herald-sessions-resume-${Date.now()}`);
    const day = join(sessionsRoot, "2026", "09", "20");
    mkdirSync(day, { recursive: true });
    const TURN = "0f6f9a5a-2f1c-4b17-9a3d-000000000000";
    const original = join(day, `rollout-2026-09-20T10-00-00-${UUID}.jsonl`);
    const resumed = join(day, `rollout-2026-09-20T11-00-00-${UUID}_${TURN}.jsonl`);
    writeFileSync(original, "{}\n");
    writeFileSync(resumed, "{}\n{}\n");
    utimesSync(original, new Date(), new Date(Date.now() - 60_000));
    utimesSync(resumed, new Date(), new Date());

    const fresh = await scanTranscriptDir(sessionsRoot);
    expect([...fresh.keys()].sort()).toEqual([TURN, UUID].sort());
    // The later write is the live transcript for both ids.
    expect(fresh.get(UUID)?.path).toBe(resumed);
    expect(fresh.get(TURN)?.path).toBe(resumed);
  });

  it("indexes Qoder transcripts as <project-slug>/<session-id>.jsonl", async () => {
    const qoderRoot = join(root, "..", `herald-qoder-${Date.now()}`);
    const project = join(qoderRoot, "-Users-me-workspace-lin594-my-repo");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${UUID}.jsonl`), "{}\n");
    writeFileSync(join(project, "segment-2026-09-20.jsonl"), "{}\n");
    writeFileSync(join(project, `${UUID}.jsonl.bak`), "{}\n"); // not .jsonl
    mkdirSync(join(qoderRoot, "empty-project"), { recursive: true });

    const fresh = await scanQoderProjects(qoderRoot);
    // Any JSONL stem is indexable: lookups happen by known session id only, so a
    // stray file can never create a phantom session.
    expect([...fresh.keys()].sort()).toEqual([UUID, "segment-2026-09-20"].sort());
    expect(fresh.get(UUID)?.size).toBeGreaterThan(0);

    expect(await scanQoderProjects(join(qoderRoot, "missing"))).toEqual(new Map());
  });
});

describe("transcript turn evidence", () => {
  const record = (type: string, message?: unknown) =>
    JSON.stringify(message === undefined ? { type } : { type, message });

  it("reads the last message through the bookkeeping records that trail it", () => {
    const lines = [
      record("user", { role: "user", content: [{ type: "text", text: "go" }] }),
      record("assistant", { role: "assistant", stop_reason: "end_turn" }),
      ...["active-leaf", "last-prompt", "workspace-directories", "runtime-config"].map(
        (type) => record(type),
      ),
    ];
    expect(classifyTranscriptTail(lines)).toBe("idle");
  });

  it("treats an unclosed turn as work in flight", () => {
    expect(
      classifyTranscriptTail([record("assistant", { role: "assistant", stop_reason: "tool_use" })]),
    ).toBe("in_flight");
    expect(
      classifyTranscriptTail([
        record("assistant", { role: "assistant", stop_reason: "tool_use" }),
        record("user", { role: "user", content: [{ type: "tool_result" }] }),
      ]),
    ).toBe("in_flight");
  });

  it("counts a user interrupt as the end of the turn", () => {
    // Real Qoder tails: the session was stopped by hand, so nothing is coming.
    for (const marker of ["[Request interrupted by user]", "[Request interrupted by user for tool use]"]) {
      expect(
        classifyTranscriptTail([
          record("user", { role: "user", content: [{ type: "tool_result" }] }),
          record("user", { role: "user", content: [{ type: "text", text: marker }] }),
        ]),
      ).toBe("idle");
    }
  });

  it("reads a Codex rollout turn bracket through the records that trail it", () => {
    // Observed vocabulary: every turn is `task_started` … `task_complete`, and
    // token counts, item completions and applied settings keep arriving both
    // during and after it.
    const event = (payload: Record<string, unknown>) =>
      JSON.stringify({ timestamp: "2026-09-26T11:21:10.375Z", ordinal: 50, type: "event_msg", payload });
    const response = (payload: Record<string, unknown>) =>
      JSON.stringify({ timestamp: "2026-09-26T11:21:10.375Z", ordinal: 51, type: "response_item", payload });
    const turn = { turn_id: "01a0dd70-feee-7cd2-8353-fa4b5db76e47" };

    expect(
      classifyTranscriptTail([
        event({ type: "task_started", ...turn }),
        response({ type: "reasoning" }),
        event({ type: "token_count" }),
        event({ type: "agent_message" }),
        event({ type: "task_complete", ...turn, duration_ms: 105188 }),
        event({ type: "thread_settings_applied" }),
        event({ type: "token_count" }),
      ]),
    ).toBe("idle");

    expect(
      classifyTranscriptTail([
        event({ type: "task_complete", ...turn }),
        event({ type: "task_started", turn_id: "01a0dd73-3142-7903-9d99-fbbb6951af2f" }),
        event({ type: "token_count" }),
      ]),
    ).toBe("in_flight");

    // A rollout that never says which turn state it is in proves nothing: the
    // clock, not the transcript, must decide.
    expect(
      classifyTranscriptTail([
        response({ type: "message", role: "assistant" }),
        event({ type: "item_completed" }),
      ]),
    ).toBeNull();
  });

  it("reports nothing for a format it cannot read", () => {
    expect(classifyTranscriptTail([])).toBeNull();
    expect(classifyTranscriptTail(["not json", record("active-leaf")])).toBeNull();
    // A Codex envelope with no payload carries no turn state to read.
    expect(classifyTranscriptTail([JSON.stringify({ type: "response_item" })])).toBeNull();
  });

  it("classifies only the tail of a real file, and only complete records", async () => {
    const dir = join(tmpdir(), `herald-tail-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${UUID}.jsonl`);
    const filler = Array.from(
      { length: 400 },
      (_, i) => `${record("user", { role: "user", text: `p${i}` })}\n`,
    ).join("");
    writeFileSync(
      path,
      filler +
        record("assistant", { role: "assistant", stop_reason: "end_turn" }) +
        "\n" +
        record("active-leaf"), // torn write: no trailing newline yet
    );
    expect(await transcriptTurnEvidence(path)).toBe("idle");

    writeFileSync(
      path,
      filler + record("assistant", { role: "assistant", stop_reason: "tool_use" }) + "\n",
    );
    expect(await transcriptTurnEvidence(path)).toBe("in_flight");

    expect(await transcriptTurnEvidence(join(dir, "missing.jsonl"))).toBeNull();
  });

  it("scanners keep the path so the tail can be read back", async () => {
    const qoderRoot = join(tmpdir(), `herald-qoder-path-${Date.now()}`);
    const project = join(qoderRoot, "-Users-me-repo");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${UUID}.jsonl`), "{}\n");
    expect((await scanQoderProjects(qoderRoot)).get(UUID)?.path).toBe(
      join(project, `${UUID}.jsonl`),
    );
  });
});
