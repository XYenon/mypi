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

export function summarizePlainText(text: string, maxLength: number): string {
  return truncateText(collapseWhitespace(text), maxLength);
}

export function summarizeHtmlText(text: string, maxLength: number): string {
  return truncateText(collapseWhitespace(decodeHtmlEntities(stripHtmlTags(text))), maxLength);
}

export function getDisplayHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return rawUrl;
  }
}
