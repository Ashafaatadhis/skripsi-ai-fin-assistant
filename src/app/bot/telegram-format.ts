const ALLOWED_HTML_TAGS = new Set(["b", "i", "u", "s", "code"]);

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeWhitespace(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeBulletLines(text: string) {
  return text.replace(/^(\s*)[-*•]\s+(.+)$/gm, (_, indent: string, content: string) => {
    return `${indent}• ${content.trim()}`;
  });
}

function stashAllowedHtmlTags(text: string) {
  const preservedTags: string[] = [];
  const stashedText = text.replace(/<\/?([a-zA-Z0-9]+)>/g, (match, tagName: string) => {
    if (!ALLOWED_HTML_TAGS.has(tagName.toLowerCase())) {
      return match;
    }

    const token = `TGTAG${preservedTags.length}X`;
    preservedTags.push(match);
    return token;
  });

  return { stashedText, preservedTags };
}

function restoreAllowedHtmlTags(text: string, preservedTags: string[]) {
  return preservedTags.reduce((result, tag, index) => {
    return result.replace(`TGTAG${index}X`, tag);
  }, text);
}

function balanceAllowedHtmlTags(text: string) {
  const tagRegex = /<\/?(b|i|u|s|code)>/g;
  const parts: string[] = [];
  const stack: Array<{ name: string; index: number; raw: string }> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(tagRegex)) {
    const raw = match[0];
    const matchedName = match[1];
    if (!matchedName) {
      continue;
    }

    const name = matchedName.toLowerCase();
    const index = match.index ?? 0;

    parts.push(text.slice(lastIndex, index));

    if (raw.startsWith("</")) {
      const top = stack[stack.length - 1];
      if (top && top.name === name) {
        parts.push(raw);
        stack.pop();
      } else {
        parts.push(escapeHtml(raw));
      }
    } else {
      const partIndex = parts.push(raw) - 1;
      stack.push({ name, index: partIndex, raw });
    }

    lastIndex = index + raw.length;
  }

  parts.push(text.slice(lastIndex));

  for (const unclosedTag of stack) {
    parts[unclosedTag.index] = escapeHtml(unclosedTag.raw);
  }

  return parts.join("");
}

function applyMarkdownFormatting(text: string) {
  let formatted = text;

  formatted = formatted.replace(/```([\s\S]*?)```/g, (_, code: string) => {
    return `<code>${code.trim()}</code>`;
  });
  formatted = formatted.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  formatted = formatted.replace(/__(.+?)__/g, "<u>$1</u>");
  formatted = formatted.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, "$1<i>$2</i>");
  formatted = formatted.replace(/(^|[^_])_(?!_)(.+?)_(?!_)/g, "$1<i>$2</i>");
  formatted = formatted.replace(/`([^`]+)`/g, "<code>$1</code>");

  return formatted;
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function stripTelegramHtml(text: string) {
  return decodeHtmlEntities(text.replace(/<\/?(b|i|u|s|code)>/g, ""));
}

export function sanitizeTelegramHtml(text: string) {
  const normalized = normalizeBulletLines(normalizeWhitespace(text));
  const { stashedText, preservedTags } = stashAllowedHtmlTags(normalized);
  const escaped = escapeHtml(stashedText);
  const formatted = applyMarkdownFormatting(escaped);
  const restored = restoreAllowedHtmlTags(formatted, preservedTags);

  return balanceAllowedHtmlTags(restored);
}
