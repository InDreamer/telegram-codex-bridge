import type { ReasoningEffort, SessionRow } from "../types.js";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatHtmlHeading(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

export function formatHtmlField(label: string, value: string): string {
  return `${formatHtmlHeading(label)} ${escapeHtml(value)}`;
}

export function chunkButtons<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function formatRelativeTime(isoTime: string): string {
  const diffMs = Math.max(0, Date.now() - Date.parse(isoTime));
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "刚刚";
  }

  if (minutes < 60) {
    return `${minutes}分钟前`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}小时前`;
  }

  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

export function formatReasoningEffortLabel(effort: ReasoningEffort): string {
  switch (effort) {
    case "none":
      return "关闭";
    case "minimal":
      return "极省";
    case "low":
      return "低";
    case "medium":
      return "中";
    case "high":
      return "高";
    case "xhigh":
      return "极高";
  }
}

export function formatSessionModelReasoningConfig(
  session: Pick<SessionRow, "selectedModel" | "selectedReasoningEffort">
): string {
  const modelLabel = session.selectedModel ?? "默认模型";
  const effortLabel = session.selectedReasoningEffort ? formatReasoningEffortLabel(session.selectedReasoningEffort) : "默认";
  return `${modelLabel} + ${effortLabel}`;
}
