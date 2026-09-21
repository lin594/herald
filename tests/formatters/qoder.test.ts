import { describe, expect, it } from "vitest";
import { EventFormatError } from "../../src/core/formatted-event.js";
import { formatIncomingEvent } from "../../src/formatters/index.js";
import { formatQoderEvent } from "../../src/formatters/qoder.js";

const SESSION = "62211ad1-730a-4de1-ae17-8ed9c4fd19a4";

describe("Qoder formatter", () => {
  it("formats PermissionRequest from tool_input.description", () => {
    const formatted = formatQoderEvent({
      agent: "qoder",
      raw: {
        hook_event_name: "PermissionRequest",
        session_id: SESSION,
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf node_modules",
          description: "Remove dependencies before reinstall",
        },
      },
    });

    expect(formatted).toMatchObject({
      agent: "qoder",
      kind: "permission_required",
      sourceEvent: "PermissionRequest",
      sessionId: SESSION,
      notification: {
        title: "Approve permission",
        body: "Remove dependencies before reinstall",
        urgency: "time_sensitive",
        group: "Qoder",
      },
    });
  });

  it("falls back to command, then tool_name, then a generic hint", () => {
    expect(
      formatQoderEvent({
        agent: "qoder",
        raw: {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }).notification.body,
    ).toBe("pnpm test");

    expect(
      formatQoderEvent({
        agent: "qoder",
        raw: { hook_event_name: "PermissionRequest", tool_name: "search_replace" },
      }).notification.body,
    ).toBe("search_replace");

    expect(
      formatQoderEvent({
        agent: "qoder",
        raw: { hook_event_name: "PermissionRequest" },
      }).notification.body,
    ).toBe("Check Qoder");
  });

  it("separates approval prompts from other user-facing notifications", () => {
    const approval = formatQoderEvent({
      agent: "qoder",
      raw: {
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        message: "Agent is requesting permission to run: rm -rf node_modules",
      },
    });
    expect(approval.kind).toBe("permission_required");

    const other = formatQoderEvent({
      agent: "qoder",
      raw: {
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
        message: "Waiting for your reply",
      },
    });
    expect(other.kind).toBe("question_required");
    expect(other.notification.body).toBe("Waiting for your reply");
  });

  it("keeps Stop a turn boundary, not a task completion", () => {
    const formatted = formatQoderEvent({
      agent: "qoder",
      raw: {
        hook_event_name: "Stop",
        session_id: SESSION,
        stop_hook_active: false,
        last_assistant_message: "Implemented the parser and all 286 tests pass.",
      },
    });

    expect(formatted.kind).toBe("completed");
    expect(formatted.notification.title).toBe("Ready to review");
    expect(formatted.notification.body).toBe(
      "Implemented the parser and all 286 tests pass.",
    );
  });

  it("marks StopFailure as failed", () => {
    const formatted = formatQoderEvent({
      agent: "qoder",
      raw: { hook_event_name: "StopFailure", error: "stream disconnected" },
    });

    expect(formatted.kind).toBe("failed");
    expect(formatted.notification.body).toBe("stream disconnected");
  });

  it("truncates long bodies to a single short line", () => {
    const formatted = formatQoderEvent({
      agent: "qoder",
      raw: {
        hook_event_name: "Stop",
        last_assistant_message: `first line\n${"x".repeat(200)}`,
      },
    });

    expect(formatted.notification.body.length).toBeLessThanOrEqual(80);
    expect(formatted.notification.body.endsWith("...")).toBe(true);
  });

  it("localizes titles and prefixes them with the project directory", () => {
    const formatted = formatQoderEvent(
      {
        agent: "qoder",
        raw: {
          hook_event_name: "PermissionRequest",
          cwd: "/Users/me/workspace/lin594/herald",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      },
      { language: "zh" },
    );

    expect(formatted.notification.title).toBe(
      "herald 需要批准",
    );
  });

  it("rejects events that carry no Qoder state change", () => {
    expect(() =>
      formatQoderEvent({
        agent: "qoder",
        raw: { hook_event_name: "PostToolUse", tool_name: "Bash" },
      }),
    ).toThrow(EventFormatError);

    expect(() => formatQoderEvent({ agent: "qoder", raw: {} })).toThrow(
      /hook_event_name/,
    );
  });

  it("routes agent=qoder through the formatter registry", () => {
    const formatted = formatIncomingEvent({
      agent: "qoder",
      raw: { hook_event_name: "Stop", last_assistant_message: "done" },
    });

    expect(formatted.notification.group).toBe("Qoder");
  });
});
