import type { FormattedAgentEvent } from "../core/formatted-event.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const COOLED_KINDS = new Set(["permission_required", "question_required"]);

export interface CooldownStore {
  get(key: string): number | undefined;
  set(key: string, ms: number): void;
}

export interface CooldownPolicyOptions {
  cooldownSeconds: number;
  ttlMs?: number;
  nowMs?: () => number;
  /** Optional durable backing so cooldown survives restarts. */
  persist?: CooldownStore;
}

export type CooldownPolicyDecision =
  | { action: "continue" }
  | {
      action: "suppress";
      reason: "cooldown";
      kind: string;
      sessionId?: string;
    };

export class CooldownPolicy {
  private readonly cooldownMs: number;
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  private readonly persist: CooldownStore | undefined;
  private readonly lastNotifiedAtMs = new Map<string, number>();

  constructor(options: CooldownPolicyOptions) {
    this.cooldownMs = options.cooldownSeconds * 1000;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.nowMs = options.nowMs ?? Date.now;
    this.persist = options.persist;
  }

  private getLast(key: string): number | undefined {
    const cached = this.lastNotifiedAtMs.get(key);
    if (cached !== undefined) return cached;
    const stored = this.persist?.get(key);
    if (stored === undefined) return undefined;
    if (this.nowMs() - stored > this.ttlMs) return undefined;
    this.lastNotifiedAtMs.set(key, stored);
    return stored;
  }

  private setLast(key: string, ms: number): void {
    this.lastNotifiedAtMs.set(key, ms);
    this.persist?.set(key, ms);
  }

  apply(
    formatted: FormattedAgentEvent,
    tokenName: string,
  ): CooldownPolicyDecision {
    this.prune();

    if (this.cooldownMs <= 0) return { action: "continue" };
    if (!COOLED_KINDS.has(formatted.kind)) return { action: "continue" };
    if (!formatted.sessionId) return { action: "continue" };

    const key = `${tokenName}:${formatted.agent}:${formatted.sessionId}`;
    const now = this.nowMs();
    const last = this.getLast(key);

    this.setLast(key, now);

    if (last !== undefined && now - last < this.cooldownMs) {
      return {
        action: "suppress",
        reason: "cooldown",
        kind: formatted.kind,
        sessionId: formatted.sessionId,
      };
    }

    return { action: "continue" };
  }

  private prune(): void {
    const now = this.nowMs();
    for (const [key, last] of this.lastNotifiedAtMs) {
      if (now - last > this.ttlMs) {
        this.lastNotifiedAtMs.delete(key);
      }
    }
  }
}
