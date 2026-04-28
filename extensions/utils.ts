import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const USER_AGENT = `${pkg.name}/${pkg.version} (+https://github.com/XYenon/mypi)`;

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncateText(text: string, maxLength: number): string {
  const normalized = text.trim();
  if (maxLength <= 0) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  if (maxLength === 1) {
    return '…';
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/gi, (match) => HTML_ENTITY_MAP[match.toLowerCase()] ?? match);
}

export function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ');
}

export function stripMarkdownDecorators(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[~*_]/g, '');
}

export function summarizePlainText(text: string, maxLength: number): string {
  return truncateText(collapseWhitespace(text), maxLength);
}

export function summarizeHtmlText(text: string, maxLength: number): string {
  return truncateText(collapseWhitespace(decodeHtmlEntities(stripHtmlTags(text))), maxLength);
}

export function summarizeMarkdownText(text: string, maxLength: number): string {
  return truncateText(collapseWhitespace(stripMarkdownDecorators(text)), maxLength);
}

export function getDisplayHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return rawUrl;
  }
}

export function shortenUrlForDisplay(rawUrl: string, maxLength: number = 72): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const query = parsed.search ? truncateText(parsed.search, 18) : '';
    return truncateText(`${host}${path}${query}`, maxLength);
  } catch {
    return truncateText(rawUrl, maxLength);
  }
}

export function extractMarkdownTitle(text: string): string | undefined {
  const heading = text.match(/^#\s+(.+)$/m)?.[1];
  if (heading) {
    return summarizeMarkdownText(heading, 120);
  }

  for (const line of text.split('\n')) {
    const summary = summarizeMarkdownText(line, 120);
    if (summary) {
      return summary;
    }
  }

  return undefined;
}

export function getPreviewLines(
  text: string,
  maxLines: number,
  maxLength: number,
  mode: 'plain' | 'markdown' | 'html' = 'plain',
): string[] {
  const summarize =
    mode === 'markdown' ? summarizeMarkdownText : mode === 'html' ? summarizeHtmlText : summarizePlainText;

  return text
    .split('\n')
    .map((line) => summarize(line, maxLength))
    .filter(Boolean)
    .slice(0, maxLines);
}
