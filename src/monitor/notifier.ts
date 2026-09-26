import type { MonitorConfig } from "./config.js";
import { safeBody, safeTitle } from "./redact.js";
import {
  passesSeverityGate,
  resolveSeverity,
  SEVERITY_DELIVERY,
} from "./severity.js";
import { fingerprintOf, type MonitorStore } from "./store.js";
import type { DecidedNotification } from "./types.js";
import type { NotificationProvider } from "../providers/types.js";

export interface NotifyOptions {
  /** skip dedup checks (explicit user-triggered tests) */
  force?: boolean;
  /** agent display name, so one session's pushes stay in a single Bark group */
  group?: string;
}

/**
 * Sends monitor-derived notifications (heartbeat/stall/resume/host/emit).
 * Decides *how hard* to say it first: the severity tier (see severity.ts) both
 * gates delivery and picks Bark's interruption level. Then applies redaction,
 * size limits, content-fingerprint dedup and heartbeat rate limiting, and
 * records every delivered attempt for restart-safe suppression.
 */
export class MonitorNotifier {
  constructor(
    private readonly store: MonitorStore,
    private readonly provider: NotificationProvider,
    private readonly config: MonitorConfig,
  ) {}

  async notify(
    sessionKey: string | null,
    notification: DecidedNotification,
    nowMs: number,
    options: NotifyOptions = {},
  ): Promise<boolean> {
    const severity = resolveSeverity(notification, this.config);
    if (!passesSeverityGate(severity, this.config)) {
      // Nothing is recorded: raising HERALD_MIN_SEVERITY later must not leave a
      // suppressed push deduped out of existence.
      console.log(`[herald] suppressed ${notification.kind} severity=${severity}`);
      return false;
    }
    const level = SEVERITY_DELIVERY[severity];
    const body = safeBody(notification.body, this.config.maxBodyChars);
    const title = safeTitle(notification.title);

    if (sessionKey && !options.force) {
      const fingerprint = fingerprintOf(sessionKey, notification.kind, body);
      if (this.store.isDuplicateFingerprint(sessionKey, notification.kind, fingerprint)) {
        return false;
      }
      if (notification.kind === "heartbeat") {
        const recent = this.store.countNotificationsSince(
          sessionKey,
          "heartbeat",
          nowMs - 3_600_000,
        );
        if (recent >= this.config.heartbeatMaxPerHour) {
          return false;
        }
      }
    }

    const result = await this.provider.send({
      title,
      body,
      urgency: level === "timeSensitive" ? "time_sensitive" : "normal",
      group: options.group ?? "Codex",
      level,
    } as Parameters<NotificationProvider["send"]>[0]);

    if (sessionKey) {
      this.store.recordNotification({
        sessionKey,
        kind: notification.kind,
        level,
        title,
        body,
        nowMs,
        ok: result.ok,
        error: result.error,
      });
      if (result.ok && !options.force) {
        const fingerprint = fingerprintOf(sessionKey, notification.kind, body);
        this.store.rememberFingerprint(sessionKey, notification.kind, fingerprint, nowMs);
      }
    }
    return result.ok;
  }
}
