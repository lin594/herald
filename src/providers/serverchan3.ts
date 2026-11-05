import { serverChan3Uid, SERVERCHAN3_SENDKEY_ERROR } from "../config/serverchan3.js";
import type { NotificationPayload, NotificationProvider, NotificationResult } from "./types.js";

type FetchLike = typeof fetch;

export class ServerChan3Provider implements NotificationProvider {
  readonly name = "serverchan3";
  // The URL contains the SendKey. Native private storage also keeps it out of
  // accidental object inspection; errors below never include it or raw responses.
  readonly #endpoint: string;

  constructor(
    sendKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 5_000,
  ) {
    const uid = serverChan3Uid(sendKey);
    try {
      this.#endpoint = `https://${uid}.push.ft07.com/send/${encodeURIComponent(sendKey)}.send`;
    } catch {
      throw new Error(SERVERCHAN3_SENDKEY_ERROR);
    }
  }

  async send(input: NotificationPayload): Promise<NotificationResult> {
    if (!input.title.trim()) {
      return { ok: false, error: "ServerChan³ requires a non-empty title" };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<NotificationResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, error: "ServerChan³ request timed out" });
      }, this.timeoutMs);
    });
    const request = (async (): Promise<NotificationResult> => {
      try {
        const response = await this.fetchImpl(this.#endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          redirect: "error",
          body: JSON.stringify({
            title: input.title,
            desp: input.body || input.title,
            ...(input.group ? { tags: input.group } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          return { ok: false, status: response.status, error: `ServerChan³ returned HTTP ${response.status}` };
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return { ok: false, status: response.status, error: "ServerChan³ returned invalid JSON" };
        }
        if (
          body === null || typeof body !== "object" || Array.isArray(body) ||
          !("code" in body) || typeof body.code !== "number" || !Number.isFinite(body.code)
        ) {
          return { ok: false, status: response.status, error: "ServerChan³ returned an invalid response" };
        }
        if (body.code !== 0) {
          return { ok: false, status: response.status, error: "ServerChan³ rejected the notification" };
        }
        return { ok: true, status: response.status };
      } catch {
        return { ok: false, error: "ServerChan³ request failed" };
      }
    })();
    try {
      return await Promise.race([request, deadline]);
    } finally {
      clearTimeout(timer!);
      controller.abort();
    }
  }
}
