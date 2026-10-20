import { expect, it } from "vitest";
import { inputRequestText } from "../../src/core/input-request.js";

it("keeps every question's choices within a phone-sized body even with verbose titles", () => {
  const questions = Array.from({ length: 3 }, (_, i) => ({ title: `Question ${i}: ${"Long explanation ".repeat(50)}`, options: ["First option ".repeat(20), "Second option ".repeat(20), `Final choice ${i}`] }));
  const text = inputRequestText({ questions }, "en")!;
  expect(text.length).toBeLessThanOrEqual(1000);
  for (const i of [0, 1, 2]) {
    expect(text).toContain(`Question ${i}`);
    expect(text).toContain(`Final choice ${i}`);
  }
});
