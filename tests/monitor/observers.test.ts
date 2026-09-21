import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import {
  matchArtifacts,
  observeGit,
  observeWorkspace,
  scanQoderProjects,
  scanTranscriptDir,
  walkWorkspace,
} from "../../src/monitor/observers.js";

const UUID = "0f6f9a5a-2f1c-4b17-9a3d-1c2b3a4f5e6d";

describe("workspace observers", () => {
  const stamp = Date.now();
  const root = join(tmpdir(), `cbm-ws-${stamp}`, "ws");
  const repo = join(tmpdir(), `cbm-ws-${stamp}`, "gitrepo");

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
    const sessionsRoot = join(root, "..", `cbm-sessions-${Date.now()}`);
    const day = join(sessionsRoot, "2026", "09", "20");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-09-20T10-00-00-${UUID}.jsonl`), "{}\n");
    writeFileSync(join(day, "README.txt"), "");
    const fresh = await scanTranscriptDir(sessionsRoot);
    expect([...fresh.keys()]).toEqual([UUID]);
    expect(fresh.get(UUID)?.size).toBeGreaterThan(0);

    expect(await scanTranscriptDir(join(sessionsRoot, "missing"))).toEqual(new Map());
  });

  it("indexes Qoder transcripts as <project-slug>/<session-id>.jsonl", async () => {
    const qoderRoot = join(root, "..", `cbm-qoder-${Date.now()}`);
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
