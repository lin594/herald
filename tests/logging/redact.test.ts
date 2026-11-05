import { describe, expect, it } from "vitest";
import { redactValue } from "../../src/logging/redact.js";

describe("redactValue", () => {
  it("redacts SendKey names in config and nested raw data", () => {
    expect(redactValue({ SERVERCHAN3_SENDKEY: "fixture", nested: { sendKey: "fixture", send_key: "fixture", "send-key": "fixture" } })).toEqual({ SERVERCHAN3_SENDKEY: "[REDACTED]", nested: { sendKey: "[REDACTED]", send_key: "[REDACTED]", "send-key": "[REDACTED]" } });
  });

  it("removes key-shaped strings from nested log text and URLs", () => {
    const key = "sctp123tfixture_secret";
    const output = JSON.stringify(redactValue({ error: `failed https://123.push.ft07.com/send/${key}.send`, list: [`key ${key}`] }));
    expect(output).not.toContain(key);
    expect(output).toContain("[REDACTED]");
  });
  it("redacts sensitive keys recursively", () => {
    expect(
      redactValue({
        token: "abc",
        nested: { authorization: "Bearer secret", ok: "safe" },
        list: [{ api_key: "key" }],
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]", ok: "safe" },
      list: [{ api_key: "[REDACTED]" }],
    });
  });

  it("redacts camelCase variants that contain the sensitive substrings", () => {
    expect(
      redactValue({
        token: "abc",
        authToken: "Bearer secret",
        apiKey: "key-123",
        tokenName: "macbook",
        tokensCount: 5,
        password: "shh",
      }),
    ).toEqual({
      token: "[REDACTED]",
      authToken: "[REDACTED]",
      apiKey: "[REDACTED]",
      tokenName: "[REDACTED]",
      tokensCount: "[REDACTED]",
      password: "[REDACTED]",
    });
  });
});
