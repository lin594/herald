import {
  composeTitle,
  stateLabel,
} from "../core/notification-text.js";
import type { MonitorConfig } from "./config.js";
import {
  matchArtifacts,
  observeGit,
  observeWorkspace,
  scanTranscriptDir,
  scanQoderProjects,
  transcriptTurnEvidence,
  type GitSummary,
  type TranscriptStat,
  type TurnEvidence,
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

type TranscriptFacts = TranscriptStat & { grew: boolean };

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
  private transcriptCache = new Map<string, TranscriptStat>();
  private readonly turnEvidenceCache = new Map<
    string,
    { version: string; evidence: TurnEvidence | null }
  >();

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
        "[herald] scheduler tick failed:",
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
      // Silence proves nothing, so ask the transcript what the last turn did.
      // "idle" retires the session quietly instead of reporting a stall.
      // When no transcript reached us, the hook's own turn accounting is the
      // evidence: a `Stop` that closed the last turn says as much about the
      // session being idle as a transcript that ends on `task_complete`, so it
      // must not fall through as "unknown" and be argued into a stall. Only a
      // session that never reported a turn at all (a cooperative `emit` agent)
      // is genuinely unobservable, and the state machine says so.
      let turnInFlight: boolean | null;
      if (session.sessionId && tf) {
        const evidence = await this.turnEvidence(session.sessionId, tf);
        turnInFlight = evidence === null ? null : evidence === "in_flight";
      } else if (session.turnStartedMs !== null) {
        turnInFlight = true;
      } else {
        turnInFlight = session.lastTurnMs === null ? null : false;
      }

      const result = evaluateSessionTick(
        {
          session,
          hostAvailable,
          processActive,
          transcriptActive,
          turnInFlight,
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
          console.log(`[herald] notified ${notification.kind} session=${session.key}`);
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
              title: composeTitle([
                "Herald",
                host.hostname,
                stateLabel("host_lost", this.config.language),
              ]),
              body:
                this.config.language === "zh"
                  ? "Host Bridge 心跳中断（睡眠或断网），期间 agent 状态未知"
                  : "Host Bridge unreachable (sleep or network). Agent state unknown until it returns.",
            },
            nowMs,
            { group: "Herald" },
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
              // Sleep is not work: an open turn's elapsed time is unknowable
              // across it, so drop the turn clock instead of reporting the
              // sleep as "本轮用时". Both turn facts go, because after a wake we
              // genuinely do not know whether the turn survived — which is
              // "unobserved", not "ended cleanly".
              turnStartedMs: null,
              lastTurnMs: null,
              status: "QUIET",
            });
            this.store.clearFingerprint(session.key, ["possible_stall", "resumed"]);
          }
        }
      }
    }
  }

  private async collectTranscriptFacts(): Promise<Map<string, TranscriptFacts>> {
    const out = new Map<string, TranscriptFacts>();
    const fresh = new Map<string, TranscriptStat>();
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
      out.set(uuid, {
        ...stat,
        grew: Boolean(
          previous && (stat.size > previous.size || stat.mtimeMs > previous.mtimeMs),
        ),
      });
    }
    this.transcriptCache = fresh;
    // A transcript that left the scan window can never be read again: drop its
    // memo so the cache tracks live sessions rather than growing forever.
    for (const sessionId of this.turnEvidenceCache.keys()) {
      if (!fresh.has(sessionId)) this.turnEvidenceCache.delete(sessionId);
    }
    return out;
  }

  /**
   * Tail classification for one transcript, memoised per session by file
   * version. Ticks run every few seconds against files that are usually
   * unchanged, and reading the whole transcript would be absurd.
   */
  private async turnEvidence(
    sessionId: string,
    stat: TranscriptStat,
  ): Promise<TurnEvidence | null> {
    const version = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    const cached = this.turnEvidenceCache.get(sessionId);
    if (cached && cached.version === version) return cached.evidence;
    const evidence = await transcriptTurnEvidence(stat.path);
    this.turnEvidenceCache.set(sessionId, { version, evidence });
    return evidence;
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
          `[herald] workspace scan failed for ${workspace.name}:`,
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
