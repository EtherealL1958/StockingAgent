import { stripTerminalSequences, type EditorTheme, type MarkdownTheme } from "@earendil-works/pi-tui";

const color = (code: number) => (text: string): string =>
  process.env.NO_COLOR !== undefined ? text : `\x1b[${code}m${text}\x1b[0m`;

export const theme = {
  accent: color(36), thinking: color(90), tool: color(33), answer: color(32),
  error: color(31), bold: color(1), dim: color(90),
};

export const markdownTheme: MarkdownTheme = {
  heading: theme.accent, link: theme.accent, linkUrl: theme.dim,
  code: theme.tool, codeBlock: text => text, codeBlockBorder: theme.dim,
  quote: theme.dim, quoteBorder: theme.dim, hr: theme.dim,
  listBullet: theme.accent, bold: theme.bold, italic: color(3),
  strikethrough: color(9), underline: color(4),
};

export const editorTheme: EditorTheme = {
  borderColor: theme.accent,
  selectList: {
    selectedPrefix: theme.accent, selectedText: theme.bold,
    description: theme.dim, scrollInfo: theme.dim, noMatch: theme.dim,
  },
};

/** Model and tool text are data, never terminal control sequences. */
export function safeTerminalText(text: string): string {
  return stripTerminalSequences(text).replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
