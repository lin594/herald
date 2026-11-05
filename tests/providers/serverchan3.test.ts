import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerChan3Provider } from "../../src/providers/serverchan3.js";
import { SERVERCHAN3_SENDKEY_ERROR } from "../../src/config/serverchan3.js";

const sendKey = "sctp123tfixture_secret";
const endpoint = `https://123.push.ft07.com/send/${sendKey}.send`;
const input = { title: "Agent · Project · Waiting", body: "**Approve** the task", urgency: "time_sensitive" as const };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  // Any accidental use of real/global fetch fails without leaving this process.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network disabled in provider tests")));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ServerChan3Provider", () => {
  it("posts title, Markdown body and pipe-separated group tags to the UID endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ code: 0 }));
    const provider = new ServerChan3Provider(sendKey, fetchMock);

    expect(await provider.send({ ...input, group: "Herald|Codex" })).toEqual({ ok: true, status: 200 });
    expect(provider.name).toBe("serverchan3");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
    const options = fetchMock.mock.calls[0][1]!;
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "content-type": "application/json" });
    expect(options.redirect).toBe("error");
    expect(JSON.parse(options.body as string)).toEqual({ title: input.title, desp: input.body, tags: "Herald|Codex" });
    expect(options.signal?.aborted).toBe(true);
    expect(inspect(provider)).not.toContain(sendKey);
  });

  it("omits absent tags and uses the title for an empty body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ code: 0 }));
    const provider = new ServerChan3Provider(sendKey, fetchMock);
    await provider.send({ ...input, body: "" });
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ title: input.title, desp: input.title });
  });

  it("encodes opaque suffix characters without changing the fixed API origin", async () => {
    const key = "sctp123tfixture/part?#";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ code: 0 }));
    await new ServerChan3Provider(key, fetchMock).send(input);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://123.push.ft07.com/send/${encodeURIComponent(key)}.send`);
  });

  it.each(["", "SCTfixture", "sctp123t", "sctpxtfixture", " sctp123tfixture", "sctp123tfixture\n", "sctp123tbad key"])("rejects invalid key shape without echoing the input (case %#)", (key) => {
    expect(() => new ServerChan3Provider(key)).toThrow(SERVERCHAN3_SENDKEY_ERROR);
  });

  it("rejects an empty title without attempting a request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(await new ServerChan3Provider(sendKey, fetchMock).send({ ...input, title: " \n" })).toEqual({ ok: false, error: "ServerChan³ requires a non-empty title" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports HTTP failure without reading or returning the raw response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(sendKey, { status: 503 }));
    expect(await new ServerChan3Provider(sendKey, fetchMock).send(input)).toEqual({ ok: false, status: 503, error: "ServerChan³ returned HTTP 503" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports non-JSON without returning the body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(sendKey));
    expect(await new ServerChan3Provider(sendKey, fetchMock).send(input)).toEqual({ ok: false, status: 200, error: "ServerChan³ returned invalid JSON" });
  });

  it.each([null, [], {}, { code: "0" }, { code: false }])("rejects malformed response shape (case %#)", async (body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    expect(await new ServerChan3Provider(sendKey, fetchMock).send(input)).toEqual({ ok: false, status: 200, error: "ServerChan³ returned an invalid response" });
  });

  it("requires numeric code zero and does not echo business errors or retry", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ code: 7, message: `${endpoint} ${sendKey}`, data: { sendKey } }));
    expect(await new ServerChan3Provider(sendKey, fetchMock).send(input)).toEqual({ ok: false, status: 200, error: "ServerChan³ rejected the notification" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not echo network exception messages containing the key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(`failed at ${endpoint}`));
    expect(await new ServerChan3Provider(sendKey, fetchMock).send(input)).toEqual({ ok: false, error: "ServerChan³ request failed" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["headers", "body"])("bounds a request whose %s never finish", async (phase) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>();
    if (phase === "headers") fetchMock.mockReturnValue(new Promise(() => {}));
    else fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response);
    let completed = false;
    const running = new ServerChan3Provider(sendKey, fetchMock).send(input).then((result) => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(completed).toBe(false);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toEqual({ ok: false, error: "ServerChan³ request timed out" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
