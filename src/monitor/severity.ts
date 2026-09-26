import type { MonitorConfig } from "./config.js";
import type { DecidedNotification } from "./types.js";

/**
 * How much a push deserves the user's attention, ordered like log levels.
 *
 * The state machine decides *what happened* (`kind`); this layer decides how
 * hard to say it, so a single kind can be retuned by configuration instead of
 * by editing the code that emits it. `debug` is the only tier that is not
 * delivered at all under the default policy.
 */
export type NotifySeverity = "debug" | "info" | "notice" | "critical";

export const SEVERITIES: readonly NotifySeverity[] = [
  "debug",
  "info",
  "notice",
  "critical",
];

export function isSeverity(value: unknown): value is NotifySeverity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

export function severityRank(severity: NotifySeverity): number {
  return SEVERITIES.indexOf(severity);
}

/**
 * Delivery strength per notification kind. Reading the table is the whole
 * policy: `critical` is reserved for the states where the agent has *stopped*
 * and needs a human, because that is the only thing a lock-screen interruption
 * is worth spending. Everything the monitor merely infers from a clock sits a
 * tier below it.
 */
export const DEFAULT_SEVERITIES: Record<string, NotifySeverity> = {
  // A cooperative agent announcing itself is activity, not a state change.
  started: "debug",
  heartbeat: "info",
  resumed: "info",
  host_lost: "notice",
  milestone: "notice",
  completed: "notice",
  possible_stall: "notice",
  waiting: "critical",
  blocked: "critical",
  failed: "critical",
};

/**
 * Bark's own interruption tiers. `passive` lands silently in the notification
 * centre, `active` is a normal alert, `timeSensitive` breaks through Focus.
 */
export const SEVERITY_DELIVERY: Record<
  NotifySeverity,
  "passive" | "active" | "timeSensitive"
> = {
  debug: "passive",
  info: "passive",
  notice: "active",
  critical: "timeSensitive",
};

/**
 * Strength for one notification. The operator's `HERALD_SEVERITY_MAP` outranks
 * everything, because an explicit configuration line is a decision while a
 * per-push severity is a heuristic. Then the push itself, then the built-in
 * table. An unknown kind defaults to `info` rather than to the loudest tier.
 */
export function resolveSeverity(
  notification: DecidedNotification,
  config: MonitorConfig,
): NotifySeverity {
  return (
    config.severityMap[notification.kind] ??
    notification.severity ??
    DEFAULT_SEVERITIES[notification.kind] ??
    "info"
  );
}

/** Below `HERALD_MIN_SEVERITY` a push is dropped before anything is sent. */
export function passesSeverityGate(
  severity: NotifySeverity,
  config: MonitorConfig,
): boolean {
  return severityRank(severity) >= severityRank(config.minSeverity);
}
