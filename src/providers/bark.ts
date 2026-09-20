import type { NotificationPayload, NotificationProvider, NotificationResult } from "./types.js";

type FetchLike = typeof fetch;

export class BarkProvider implements NotificationProvider {
  readonly name = "bark";

  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 5000,
    private readonly retryBackoffMs: number[] = [1000, 2000],
  ) {}

  private async sendOnce(input: NotificationPayload): Promise<NotificationResult> {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          group: input.group,
          sound: input.sound,
          url: input.url,
          icon: input.icon,
          level:
            input.level ?? (input.urgency === "time_sensitive" ? "timeSensitive" : "active"),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: `Bark returned HTTP ${response.status}`,
        };
      }

      return { ok: true, status: response.status };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Bounded-backoff retry; a provider failure must never crash the server. */
  async send(input: NotificationPayload): Promise<NotificationResult> {
    let last: NotificationResult = { ok: false, error: "not attempted" };
    const attempts = [0, ...this.retryBackoffMs];
    for (const delayMs of attempts) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.());
      }
      last = await this.sendOnce(input);
      if (last.ok) return last;
      // HTTP-level rejection from Bark itself: retrying won't help a bad key.
      if (last.status !== undefined) return last;
    }
    return last;
  }
}
