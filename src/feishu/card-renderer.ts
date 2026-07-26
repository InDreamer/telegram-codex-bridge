import type { TelegramInlineKeyboardButton, TelegramInlineKeyboardMarkup } from "../telegram/api.js";
import { parseCallbackData } from "../telegram/ui-callbacks.js";

interface FeishuCardBodyElement {
  tag: string;
  [key: string]: unknown;
}

interface ParsedHtmlCard {
  title: string;
  sections: string[];
  numberedLabels: Map<number, string>;
  summary: string;
}

interface SemanticButton {
  text: string;
  callbackData: string;
  priority: number;
  overflowEligible: boolean;
  type: "default" | "primary" | "danger";
  confirm?: {
    title: string;
    text: string;
  };
}

const CARD_HORIZONTAL_SPACING = "8px";
const CARD_VERTICAL_SPACING = "8px";
const BUTTON_ROW_SIZE = 3;
const CARD_SUMMARY_LIMIT = 72;
const BUTTON_LABEL_LIMIT = 28;

const COMMAND_LABELS: Record<string, string> = {
  help: "Help",
  new: "新建会话",
  status: "当前状态",
  sessions: "Recent",
  interrupt: "中断操作",
  inspect: "查看详情",
  hub: "Hub"
};

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gu, " ")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function stripHtml(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]+>/gu, "")).trim();
}

function truncatePlainText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function htmlToLarkMarkdown(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/p>/giu, "\n\n")
      .replace(/<p[^>]*>/giu, "")
      .replace(/<(strong|b)>/giu, "**")
      .replace(/<\/(strong|b)>/giu, "**")
      .replace(/<(em|i)>/giu, "*")
      .replace(/<\/(em|i)>/giu, "*")
      .replace(/<code>/giu, "`")
      .replace(/<\/code>/giu, "`")
      .replace(/<pre[^>]*>/giu, "```\n")
      .replace(/<\/pre>/giu, "\n```")
      .replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/giu, "[$2]($1)")
      .replace(/<[^>]+>/gu, "")
  ).trim();
}

function parseHtmlCard(html: string): ParsedHtmlCard {
  const lines = html.replace(/\r/gu, "").split("\n");
  while (lines[0] && lines[0].trim().length === 0) {
    lines.shift();
  }

  let title = "Codex Bridge";
  if (lines[0]) {
    const firstLine = lines[0].trim();
    const headingMatch = firstLine.match(/^<b>([^<]+)<\/b>$/u);
    if (headingMatch?.[1]) {
      title = stripHtml(headingMatch[1]);
      lines.shift();
    } else {
      const plain = stripHtml(firstLine);
      if (plain) {
        title = plain;
        lines.shift();
      }
    }
  }

  const body = lines.join("\n").trim();
  const sections = body.length === 0
    ? []
    : body
      .split(/\n\s*\n/gu)
      .map((section) => htmlToLarkMarkdown(section))
      .filter((section) => section.length > 0);

  const numberedLabels = new Map<number, string>();
  const plainBodyLines = body.split("\n").map((line) => stripHtml(line)).filter((line) => line.length > 0);
  for (const line of plainBodyLines) {
    const numberedMatch = line.match(/^(\d+)\.\s+(.+)$/u);
    if (numberedMatch?.[1] && numberedMatch[2]) {
      numberedLabels.set(Number.parseInt(numberedMatch[1], 10), numberedMatch[2].trim());
    }
  }

  const summary = truncatePlainText(
    sections.map((section) => stripHtml(section)).find((section) => section.length > 0) ?? title,
    CARD_SUMMARY_LIMIT
  );

  return {
    title: truncatePlainText(title, 80),
    sections,
    numberedLabels,
    summary
  };
}

function mapCallbackToLabel(
  button: TelegramInlineKeyboardButton,
  numberedLabels: Map<number, string>
): string {
  const parsed = parseCallbackData(button.callback_data);
  const numericValue = /^\d+$/u.test(button.text) ? Number.parseInt(button.text, 10) : null;
  if (numericValue !== null && numberedLabels.has(numericValue)) {
    return truncatePlainText(numberedLabels.get(numericValue)!, BUTTON_LABEL_LIMIT);
  }

  switch (parsed?.kind) {
    case "new_browse_open":
      return "Browse";
    case "path_manual":
      return "Manual Path";
    case "path_back":
    case "new_browse_back":
    case "browse_back":
      return "Back";
    case "browse_use_current_dir":
      return "在当前目录新建";
    case "browse_use_current_dir_confirm":
      return "Confirm";
    case "browse_use_current_dir_cancel":
      return "返回目录";
    case "browse_refresh":
      return "Refresh";
    case "browse_root":
      return "Project Root";
    case "browse_up":
      return "Up";
    case "browse_close":
      return "Close";
    case "status_inspect":
      return "查看详情";
    case "status_interrupt":
      return "中断操作";
    case "commands_open":
      return "Commands";
    case "commands_help":
      return "Help";
    case "commands_run":
      return COMMAND_LABELS[parsed.command] ?? button.text;
    case "hub_select":
      return button.text === "·" ? "Empty" : `会话 ${button.text}`;
    default:
      return truncatePlainText(button.text, BUTTON_LABEL_LIMIT);
  }
}

function isOverflowEligible(button: TelegramInlineKeyboardButton): boolean {
  const parsed = parseCallbackData(button.callback_data);
  switch (parsed?.kind) {
    case "browse_back":
    case "browse_refresh":
    case "browse_close":
    case "browse_root":
    case "new_browse_back":
    case "path_back":
    case "commands_help":
    case "commands_edit_open":
    case "commands_edit_close":
    case "runtime_close":
    case "model_close":
    case "inspect_close":
    case "rollback_close":
      return true;
    default:
      return false;
  }
}

function buttonPriority(button: TelegramInlineKeyboardButton): number {
  const parsed = parseCallbackData(button.callback_data);
  if (button.style === "primary") {
    return 100;
  }

  switch (parsed?.kind) {
    case "pick":
    case "path_confirm":
    case "new_browse_open":
    case "path_manual":
    case "browse_use_current_dir":
    case "status_inspect":
    case "status_interrupt":
      return 90;
    case "commands_run":
      return parsed.command === "new" || parsed.command === "status" ? 90 : 75;
    case "browse_back":
    case "browse_close":
    case "browse_refresh":
    case "browse_root":
    case "new_browse_back":
    case "path_back":
      return 20;
    default:
      return 60;
  }
}

function resolveButtonType(button: TelegramInlineKeyboardButton): "default" | "primary" | "danger" {
  const parsed = parseCallbackData(button.callback_data);
  if (parsed?.kind === "status_interrupt" || (parsed?.kind === "commands_run" && parsed.command === "interrupt")) {
    return "danger";
  }
  if (button.style === "primary") {
    return "primary";
  }
  if (parsed?.kind === "pick" || parsed?.kind === "path_confirm" || parsed?.kind === "new_browse_open") {
    return "primary";
  }

  return "default";
}

function buildButtonConfirm(button: TelegramInlineKeyboardButton): SemanticButton["confirm"] {
  const parsed = parseCallbackData(button.callback_data);
  if (parsed?.kind === "status_interrupt" || (parsed?.kind === "commands_run" && parsed.command === "interrupt")) {
    return {
      title: "确认中断",
      text: "要停止当前正在运行的操作吗？"
    };
  }

  return undefined;
}

function normalizeButtons(replyMarkup: TelegramInlineKeyboardMarkup | undefined, numberedLabels: Map<number, string>): SemanticButton[] {
  const flattened = (replyMarkup?.inline_keyboard ?? []).flat();
  return flattened.map((button) => {
    const confirm = buildButtonConfirm(button);
    return {
      text: mapCallbackToLabel(button, numberedLabels),
      callbackData: button.callback_data,
      priority: buttonPriority(button),
      overflowEligible: isOverflowEligible(button),
      type: resolveButtonType(button),
      ...(confirm ? { confirm } : {})
    };
  });
}

function partitionButtons(buttons: SemanticButton[]): {
  mainButtons: SemanticButton[];
  overflowButtons: SemanticButton[];
} {
  if (buttons.length <= 4) {
    return {
      mainButtons: buttons,
      overflowButtons: []
    };
  }

  const overflowButtons: SemanticButton[] = [];
  const survivors: SemanticButton[] = [];
  for (const button of buttons) {
    if (button.overflowEligible) {
      overflowButtons.push(button);
    } else {
      survivors.push(button);
    }
  }

  const highPriority = survivors.filter((button) => button.priority >= 80);
  const mainButtons: SemanticButton[] = [];
  for (const button of highPriority) {
    if (mainButtons.length < 5) {
      mainButtons.push(button);
    } else {
      overflowButtons.push(button);
    }
  }

  for (const button of survivors) {
    if (mainButtons.includes(button)) {
      continue;
    }
    if (mainButtons.length < 5) {
      mainButtons.push(button);
    } else {
      overflowButtons.push(button);
    }
  }

  return {
    mainButtons,
    overflowButtons
  };
}

function buildButtonElement(button: SemanticButton): FeishuCardBodyElement {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: button.text
    },
    type: button.type,
    size: "medium",
    width: "default",
    behaviors: [{
      type: "callback",
      value: {
        callback_data: button.callbackData
      }
    }],
    ...(button.confirm ? {
      confirm: {
        title: {
          tag: "plain_text",
          content: button.confirm.title
        },
        text: {
          tag: "plain_text",
          content: button.confirm.text
        }
      }
    } : {})
  };
}

function buildOverflowElement(buttons: SemanticButton[]): FeishuCardBodyElement {
  return {
    tag: "overflow",
    width: "default",
    options: buttons.map((button) => ({
      text: {
        tag: "plain_text",
        content: button.text
      },
      value: button.callbackData
    }))
  };
}

function buildButtonRows(mainButtons: SemanticButton[], overflowButtons: SemanticButton[]): FeishuCardBodyElement[] {
  const rows: Array<Array<FeishuCardBodyElement>> = [];
  for (let index = 0; index < mainButtons.length; index += BUTTON_ROW_SIZE) {
    rows.push(mainButtons.slice(index, index + BUTTON_ROW_SIZE).map((button) => buildButtonElement(button)));
  }

  if (overflowButtons.length > 0) {
    const overflowElement = buildOverflowElement(overflowButtons);
    const lastRow = rows.at(-1);
    if (lastRow && lastRow.length < BUTTON_ROW_SIZE) {
      lastRow.push(overflowElement);
    } else {
      rows.push([overflowElement]);
    }
  }

  return rows.map((row, index) => ({
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: CARD_HORIZONTAL_SPACING,
    margin: index === 0 ? "4px 0px 0px 0px" : "0px 0px 0px 0px",
    columns: row.map((element, columnIndex) => ({
      tag: "column",
      width: "auto",
      elements: [element],
      padding: "0px",
      vertical_spacing: "0px",
      element_id: `cta_col_${index}_${columnIndex}`
    }))
  }));
}

function selectHeaderTemplate(title: string): string {
  if (/错误|失败|异常|Error|Failed/iu.test(title)) {
    return "red";
  }
  if (/欢迎|Welcome/iu.test(title)) {
    return "green";
  }
  if (/运行|Runtime|Hub/iu.test(title)) {
    return "indigo";
  }
  if (/状态|配置|接入|Status/iu.test(title)) {
    return "blue";
  }
  if (/文件浏览|文件预览|Browser|Preview/iu.test(title)) {
    return "wathet";
  }

  return "default";
}

function shouldDisableForward(title: string, hasCallbacks: boolean): boolean {
  if (hasCallbacks) {
    return true;
  }

  return /状态|当前会话|运行|选择|文件浏览|预览|快捷指令|欢迎|接入|Status|Runtime|Browser|Commands|Welcome/iu.test(title);
}

function buildBodyElements(parsed: ParsedHtmlCard, replyMarkup?: TelegramInlineKeyboardMarkup): FeishuCardBodyElement[] {
  const textElements: FeishuCardBodyElement[] = parsed.sections.length === 0
    ? [{
        tag: "markdown",
        content: "-",
        text_align: "left",
        margin: "0px 0px 0px 0px"
      }]
    : parsed.sections.map((section, index) => ({
        tag: "markdown",
        content: section,
        text_align: "left",
        margin: index === 0 ? "0px 0px 0px 0px" : "4px 0px 0px 0px"
      }));

  if (!replyMarkup) {
    return textElements;
  }

  const normalizedButtons = normalizeButtons(replyMarkup, parsed.numberedLabels);
  const { mainButtons, overflowButtons } = partitionButtons(normalizedButtons);
  return [...textElements, ...buildButtonRows(mainButtons, overflowButtons)];
}

export function buildFeishuInteractiveCard(
  html: string,
  replyMarkup?: TelegramInlineKeyboardMarkup
): string {
  const parsed = parseHtmlCard(html);
  const bodyElements = buildBodyElements(parsed, replyMarkup);
  const hasCallbacks = Boolean(replyMarkup && replyMarkup.inline_keyboard.some((row) => row.length > 0));
  const disableForward = shouldDisableForward(parsed.title, hasCallbacks);

  return JSON.stringify({
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
      enable_forward: !disableForward,
      summary: {
        content: parsed.summary
      }
    },
    header: {
      title: {
        tag: "plain_text",
        content: parsed.title
      },
      template: selectHeaderTemplate(parsed.title),
      padding: "12px 12px 12px 12px"
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      vertical_spacing: CARD_VERTICAL_SPACING,
      elements: bodyElements
    }
  });
}
