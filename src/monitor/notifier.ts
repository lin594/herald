import type { MonitorConfig } from "./config.js";
import { limitBody, looksLikeSecretDump, redactText } from "./redact.js";
import { fingerprintOf, type MonitorStore } from "./store.js";
import type { DecidedNotification } from "./types.js";
import type { NotificationProvider } from "../providers/types.js";

export interface NotifyOptions {
  /** skip dedup checks (explicit user-triggered tests) */
  force?: boolean;
}

/**
 * Sends monitor-derived notifications (heartbeat/stall/resume/host/emit).
 * Applies redaction, size limits, content-fingerprint dedup and heartbeat
 * rate limiting, and records every attempt for restart-safe suppression.
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
    const body = redactText(notification.body);
    const safeBody = looksLikeSecretDump(body)
      ? "(content suppressed: looks like secret material)"
      : limitBody(body, this.config.maxBodyChars);
    const title = limitBody(redactText(notification.title), 120);

    if (sessionKey && !options.force) {
      const fingerprint = fingerprintOf(sessionKey, notification.kind, safeBody);
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
      body: safeBody,
      urgency: notification.level === "timeSensitive" ? "time_sensitive" : "normal",
      group: "Codex",
      level: notification.level,
    } as Parameters<NotificationProvider["send"]>[0]);

    if (sessionKey) {
      this.store.recordNotification({
        sessionKey,
        kind: notification.kind,
        level: notification.level,
        title,
        body: safeBody,
        nowMs,
        ok: result.ok,
        error: result.error,
      });
      if (result.ok && !options.force) {
        const fingerprint = fingerprintOf(sessionKey, notification.kind, safeBody);
        this.store.rememberFingerprint(sessionKey, notification.kind, fingerprint, nowMs);
      }
    }
    return result.ok;
  }
}
