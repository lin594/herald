import type { MonitorConfig } from "./config.js";
import {
  matchArtifacts,
  observeGit,
  observeWorkspace,
  scanTranscriptDir,
  scanQoderProjects,
  type GitSummary,
} from "./observers.js";
import type { MonitorNotifier } from "./notifier.js";
import { agentLabel, evaluateSessionTick } from "./statemachine.js";
import type { MonitorStore } from "./store.js";
import type { SessionRecord } from "./types.js";

interface ObservationFact {
  atMs: number;
  processCount: number;
  sleepGapSeconds?: number;
}

export class MonitorScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly observations = new Map<string, ObservationFact>(); // sessionId -> facts
  private readonly workspaceState = new Map<
    string,
    {
      signatures: Map<string, number> | null;
      lastGitScanMs: number;
      git: GitSummary | null;
    }
  >();
  private transcriptCache = new Map<string, { mtimeMs: number; size: number }>();

  constructor(
    private readonly store: MonitorStore,
    private readonly notifier: MonitorNotifier,
    private readonly config: MonitorConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(), this.config.tickSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  recordObservation(input: {
    sessionId?: string;
    atMs: number;
    processCount: number;
    sleepGapSeconds?: number;
  }): void {
    if (!input.sessionId) return;
    this.observations.set(input.sessionId, {
      atMs: input.atMs,
      processCount: input.processCount,
      sleepGapSeconds: input.sleepGapSeconds,
    });
  }

  async run(nowMs = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick(nowMs);
    } catch (error) {
      console.error(
        "[cbm] scheduler tick failed:",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  private async tick(nowMs: number): Promise<void> {
    await this.evaluateHosts(nowMs);
    const transcriptFacts = await this.collectTranscriptFacts();
    await this.collectWorkspaceFacts(nowMs);

    for (const session of this.store.listSessions()) {
      if (session.status === "COMPLETED" || session.status === "UNKNOWN") continue;
      const hostAvailable = this.isHostAvailable(session, nowMs);
      const observation = session.sessionId ? this.observations.get(session.sessionId) : undefined;
      const processActive =
        observation !== undefined &&
        observation.processCount > 0 &&
        nowMs - observation.atMs < Math.max(this.config.quietSeconds, 120) * 1000;
      const tf = session.sessionId ? transcriptFacts.get(session.sessionId) : undefined;
      const transcriptActive = tf?.grew ?? false;

      const result = evaluateSessionTick(
        {
          session,
          hostAvailable,
          processActive,
          transcriptActive,
        },
        this.config,
        nowMs,
      );

      if (Object.keys(result.updates).length > 0) {
        this.store.updateSession(session.key, result.updates);
      }
      for (const kind of result.clearedDedupKinds) {
        this.store.clearFingerprint(session.key, [kind]);
      }
      for (const notification of result.notifications) {
        const sent = await this.notifier.notify(session.key, notification, nowMs, {
          group: agentLabel(session.agentType),
        });
        if (sent) {
          console.log(`[cbm] notified ${notification.kind} session=${session.key}`);
        }
      }
    }
  }

  private isHostAvailable(session: SessionRecord, nowMs: number): boolean {
    const hosts = this.store.listHosts();
    if (hosts.length === 0) return true; // no bridge configured: don't block logic
    const relevant = session.hostname
      ? hosts.filter((host) => host.hostname === session.hostname)
      : hosts;
    if (relevant.length === 0) return true;
    return relevant.every(
      (host) =>
        host.lastHeartbeatMs != null &&
        nowMs - host.lastHeartbeatMs < this.config.hostHeartbeatTimeoutSeconds * 1000,
    );
  }

  private async evaluateHosts(nowMs: number): Promise<void> {
    for (const host of this.store.listHosts()) {
      const heartbeatAgeMs =
        host.lastHeartbeatMs == null ? Number.POSITIVE_INFINITY : nowMs - host.lastHeartbeatMs;
      const timeoutMs = this.config.hostHeartbeatTimeoutSeconds * 1000;
      if (host.status === "HOST_AVAILABLE" && heartbeatAgeMs > timeoutMs) {
        this.store.setHostStatus(host.hostname, "HOST_UNREACHABLE", nowMs);
        const hasWorkingSession = this.store
          .listSessions()
          .some(
            (session) =>
              (session.hostname === host.hostname || session.hostname === null) &&
              ["STARTED", "ACTIVE", "QUIET"].includes(session.status),
          );
        if (hasWorkingSession) {
          await this.notifier.notify(
            `host:${host.hostname}`,
            {
              kind: "host_lost",
              level: "active",
              title: `[Monitor] ${host.hostname} · Host Signal Lost`,
              body: "Host Bridge unreachable (sleep or network). Agent state unknown until it returns.",
            },
            nowMs,
          );
        }
      } else if (
        host.status === "HOST_UNREACHABLE" &&
        host.lastHeartbeatMs != null &&
        heartbeatAgeMs <= timeoutMs
      ) {
        this.store.setHostStatus(host.hostname, "HOST_AVAILABLE", nowMs);
        this.store.clearFingerprint(`host:${host.hostname}`, ["host_lost"]);
        // Sleep/wake handling: re-baseline activity clocks so a 12h sleep never
        // becomes a 12h stall. No notification replay.
        for (const session of this.store.listSessions()) {
          if (
            (session.hostname === host.hostname || session.hostname === null) &&
            ["STARTED", "ACTIVE", "QUIET", "UNKNOWN"].includes(session.status)
          ) {
            this.store.updateSession(session.key, {
              lastActivityMs: nowMs,
              updatedAtMs: nowMs,
              lastHeartbeatMs: nowMs, // don't fire an instant "still running" beat on wake
              status: "QUIET",
            });
            this.store.clearFingerprint(session.key, ["possible_stall", "resumed"]);
          }
        }
      }
    }
  }

  private async collectTranscriptFacts(): Promise<Map<string, { grew: boolean }>> {
    const out = new Map<string, { grew: boolean }>();
    const fresh = new Map<string, { mtimeMs: number; size: number }>();
    if (this.config.transcriptDir) {
      for (const [uuid, stat] of await scanTranscriptDir(this.config.transcriptDir)) {
        fresh.set(uuid, stat);
      }
    }
    if (this.config.qoderDir) {
      for (const [uuid, stat] of await scanQoderProjects(this.config.qoderDir)) {
        fresh.set(uuid, stat);
      }
    }
    for (const [uuid, stat] of fresh) {
      const previous = this.transcriptCache.get(uuid);
      if (previous && (stat.size > previous.size || stat.mtimeMs > previous.mtimeMs)) {
        out.set(uuid, { grew: true });
      }
    }
    this.transcriptCache = fresh;
    return out;
  }

  private async collectWorkspaceFacts(nowMs: number): Promise<void> {
    for (const workspace of this.config.workspaces) {
      let state = this.workspaceState.get(workspace.name);
      if (!state) {
        state = { signatures: null, lastGitScanMs: 0, git: null };
        this.workspaceState.set(workspace.name, state);
      }
      let delta;
      try {
        delta = await observeWorkspace(workspace, state);
      } catch (error) {
        console.error(
          `[cbm] workspace scan failed for ${workspace.name}:`,
          error instanceof Error ? error.message : String(error),
        );
        continue; // isolation: one workspace failure must not kill others
      }
      if (delta.changedFiles > 0) {
        const artifacts = matchArtifacts(delta.changedPaths, workspace.artifacts);
        for (const session of this.store.listSessions()) {
          const matches =
            session.project === (workspace.project ?? workspace.name) ||
            session.workspace === workspace.path;
          if (!matches) continue;
          this.store.updateSession(session.key, {
            lastActivityMs: nowMs,
            updatedAtMs: nowMs,
            changedFiles: Math.max(session.changedFiles, delta.changedFiles),
            ...(artifacts.length > 0
              ? { lastArtifacts: [...new Set([...(session.lastArtifacts?.split(", ") ?? []), ...artifacts])].slice(-5).join(", ") }
              : {}),
          });
        }
      }
      if (nowMs - state.lastGitScanMs >= this.config.gitScanIntervalSeconds * 1000) {
        state.lastGitScanMs = nowMs;
        const git = await observeGit(workspace.path);
        state.git = git;
        if (git) {
          for (const session of this.store.listSessions()) {
            const matches =
              session.project === (workspace.project ?? workspace.name) ||
              session.workspace === workspace.path;
            if (!matches) continue;
            this.store.updateSession(session.key, {
              insertions: git.insertions,
              deletions: git.deletions,
              changedFiles: Math.max(
                session.changedFiles,
                git.dirtyFiles,
              ),
            });
          }
        }
      }
    }
  }
}
