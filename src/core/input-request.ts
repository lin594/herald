import { notificationPreview } from "./notification-text.js";
import type { NotificationLanguage } from "./language.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the displayed questions and option labels, never arbitrary tool input. */
export function inputRequestText(input: unknown, language: NotificationLanguage): string | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null;
  const questions = input.questions.slice(0, 3).flatMap((question) => {
    if (!isRecord(question)) return [];
    const title = typeof question.question === "string" ? question.question : question.title;
    if (typeof title !== "string" || !title.trim()) return [];
    const options = Array.isArray(question.options) ? question.options : [];
    const labels = options.slice(0, 3).flatMap((option) => {
      const label = isRecord(option) ? option.label : option;
      return typeof label === "string" && label.trim() ? [notificationPreview(label, 45)] : [];
    });
    return [notificationPreview(title, 180), ...(labels.length ? [
      `${language === "zh" ? "选项：" : "Options: "}${labels.join(" / ")}`,
    ] : [])];
  });
  return questions.length ? questions.join("\n").slice(0, 1000) : null;
}
