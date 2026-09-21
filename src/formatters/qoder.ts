import type { IncomingAgentEvent } from "../core/incoming-event.js";
import {
  EventFormatError,
  type FormattedAgentEvent,
} from "../core/formatted-event.js";
import {
  defaultNotificationLanguage,
  type NotificationLanguage,
} from "../core/language.js";
import { prefixTitleWithProject } from "./project-title.js";

const MAX_BODY_LENGTH = 80;

type UnknownRecord = Record<string, unknown>;

export interface FormatterOptions {
  language?: NotificationLanguage;
  cwd?: string;
  projectMap?: Record<string, string>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength = MAX_BODY_LENGTH): string {
  const text = oneLine(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function requireRawRecord(raw: unknown): UnknownRecord {
  if (!isRecord(raw)) {
    throw new EventFormatError("Qoder raw payload must be an object");
  }
  return raw;
}

function requireHookEvent(raw: UnknownRecord): string {
  const hookEvent = getString(raw.hook_event_name);
  if (!hookEvent) {
    throw new EventFormatError("Qoder raw payload is missing hook_event_name");
  }
  return hookEvent;
}

function sessionId(raw: UnknownRecord): string | undefined {
  return getString(raw.session_id);
}

export function formatQoderEvent(
  event: IncomingAgentEvent,
  options?: FormatterOptions,
): FormattedAgentEvent {
  const language = options?.language ?? defaultNotificationLanguage;
  const raw = requireRawRecord(event.raw);
  const sourceEvent = requireHookEvent(raw);
  const cwd = options?.cwd ?? raw.cwd;
  const title = (value: string) =>
    prefixTitleWithProject(value, cwd, {
      agent: "Qoder",
      projectMap: options?.projectMap,
      language,
      sessionId: sessionId(raw),
    });

  // Qoder ships the Claude-Code-style hook family: PermissionRequest fires
  // before the approval prompt, Notification covers auth/elicitation prompts.
  if (sourceEvent === "PermissionRequest") {
    const tool = getString(raw.tool_name);
    const input = isRecord(raw.tool_input) ? raw.tool_input : {};
    return {
      agent: event.agent,
      kind: "permission_required",
      sourceEvent,
      sessionId: sessionId(raw),
      notification: {
        title: title(language === "zh" ? "需要批准" : "Approve permission"),
        body: truncate(
          getString(input.description) ??
            getString(input.command) ??
            tool ??
            (language === "zh" ? "请回到 Qoder 查看" : "Check Qoder"),
        ),
        urgency: "time_sensitive",
        group: "Qoder",
      },
    };
  }

  if (sourceEvent === "Notification") {
    const isPermission =
      getString(raw.notification_type) === "permission_prompt";
    return {
      agent: event.agent,
      kind: isPermission ? "permission_required" : "question_required",
      sourceEvent,
      sessionId: sessionId(raw),
      notification: {
        title: title(
          isPermission
            ? language === "zh"
              ? "需要批准"
              : "Approve permission"
            : language === "zh"
              ? "需要回答"
              : "Question",
        ),
        body: truncate(
          getString(raw.message) ??
            (language === "zh" ? "请回到 Qoder 查看" : "Check Qoder"),
        ),
        urgency: "time_sensitive",
        group: "Qoder",
      },
    };
  }

  if (sourceEvent === "Stop") {
    return {
      agent: event.agent,
      kind: "completed",
      sourceEvent,
      sessionId: sessionId(raw),
      notification: {
        title: title(language === "zh" ? "待审阅" : "Ready to review"),
        body: truncate(
          getString(raw.last_assistant_message) ??
            (language === "zh" ? "看看结果或下一步" : "Review results or next steps"),
        ),
        urgency: "time_sensitive",
        group: "Qoder",
      },
    };
  }

  if (sourceEvent === "StopFailure") {
    return {
      agent: event.agent,
      kind: "failed",
      sourceEvent,
      sessionId: sessionId(raw),
      notification: {
        title: title(language === "zh" ? "失败" : "Failed"),
        body: truncate(
          getString(raw.error) ??
            getString(raw.message) ??
            (language === "zh" ? "任务异常终止" : "Task failed"),
        ),
        urgency: "time_sensitive",
        group: "Qoder",
      },
    };
  }

  throw new EventFormatError(`Unsupported Qoder hook event: ${sourceEvent}`);
}
