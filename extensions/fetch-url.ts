import * as https from 'https';
import * as http from 'http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'url';
import {
  ExtensionAPI,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  withFileMutationQueue,
  keyHint,
} from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { Text } from '@mariozechner/pi-tui';
import {
  extractMarkdownTitle,
  getDisplayHostname,
  getPreviewLines,
  shortenUrlForDisplay,
  truncateText,
  USER_AGENT,
} from './utils.js';

type FetchUrlSource =
  | 'direct-text'
  | 'direct-json'
  | 'direct-markdown'
  | 'rsc'
  | 'readability'
  | 'next-rsc'
  | 'jina-reader';

interface FetchUrlToolDetails {
  url: string;
  finalUrl: string;
  source: FetchUrlSource;
  title?: string;
  contentType: string;
  statusCode: number;
  contentLength: number;
  fullOutputPath?: string;
  truncation?: {
    truncated: boolean;
    outputLines: number;
    totalLines: number;
    outputBytes: number;
    totalBytes: number;
  };
}

async function writeFullOutput(prefix: string, content: string, filename: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  const tempFile = join(tempDir, filename);
  await withFileMutationQueue(tempFile, async () => {
    await writeFile(tempFile, content, 'utf8');
  });
  return tempFile;
}

function getSourceLabel(source: FetchUrlSource): string {
  switch (source) {
    case 'direct-text':
      return 'Direct text';
    case 'direct-json':
      return 'Direct JSON';
    case 'direct-markdown':
      return 'Direct Markdown';
    case 'rsc':
      return 'RSC payload';
    case 'readability':
      return 'Readable article';
    case 'next-rsc':
      return 'Next.js payload';
    case 'jina-reader':
      return 'Jina Reader';
  }
}

function getPreviewMode(source: FetchUrlSource): 'plain' | 'markdown' {
  switch (source) {
    case 'direct-markdown':
    case 'readability':
    case 'jina-reader':
      return 'markdown';
    default:
      return 'plain';
  }
}

function stripRenderedTruncationNotice(text: string): string {
  return text.replace(/\n\n\[Output truncated:[\s\S]*\]$/, '');
}

// Helper to fetch URL content
function fetchContent(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  maxRedirects: number = 5,
): Promise<{ data: string; contentType: string; statusCode: number; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const requestHeaders = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json,*/*;q=0.5',
      ...headers,
    };

    const req = client.get(url, { headers: requestHeaders, signal }, (res) => {
      // Handle redirects (3xx status codes)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Resolve relative URLs
        const redirectUrl = new URL(res.headers.location, url).toString();
        fetchContent(redirectUrl, headers, signal, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          data,
          contentType: res.headers['content-type'] || '',
          statusCode: res.statusCode || 0,
          finalUrl: url,
        });
      });
    });

    req.on('error', reject);
    if (signal?.aborted) {
      req.destroy();
      reject(new Error('Request aborted'));
    }
  });
}

// Simple RSC parser (extracts strings from React Server Component payload)
function parseRsc(data: string): string {
  // RSC format is complex and evolves, but often looks like: 1:"..."\n2:["$","..."]
  // We'll try to extract substantial string content by parsing lines as JSON.
  const lines = data.split('\n');
  const extracted: string[] = [];

  for (const line of lines) {
    // Skip empty lines and comment lines
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // RSC rows typically start with "N:" where N is a number
    const rowMatch = trimmed.match(/^(\d+):(.+)$/);
    if (!rowMatch) continue;

    const [, , payload] = rowMatch;

    try {
      // Try to parse the payload as JSON
      const parsed = JSON.parse(payload);

      // Handle string values directly
      if (typeof parsed === 'string' && parsed.length > 20) {
        if (!parsed.startsWith('$') && !parsed.startsWith('@')) {
          extracted.push(parsed);
        }
        continue;
      }

      // Handle arrays (RSC row format: ["$","tag",...])
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item.length > 20) {
            if (!item.startsWith('$') && !item.startsWith('@') && !item.startsWith('[')) {
              extracted.push(item);
            }
          }
        }
      }
    } catch {
      // If JSON parsing fails, try extracting quoted strings as fallback
      const stringMatches = payload.match(/"((?:[^"\\]|\\.)*)"/g);
      if (stringMatches) {
        for (const match of stringMatches) {
          try {
            const content = JSON.parse(match);
            if (typeof content === 'string' && content.length > 20) {
              if (!content.startsWith('$') && !content.startsWith('@')) {
                extracted.push(content);
              }
            }
          } catch {
            // Ignore parsing errors
          }
        }
      }
    }
  }

  return extracted.join('\n\n');
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'fetch_url',
    label: 'Fetch URL (Smart)',
    description: `Fetch a URL and convert it to Markdown. Tries local HTML parsing (Readability), then RSC parsing, then falls back to Jina Reader. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, the full output is saved to a temp file and the path is returned.`,
    promptSnippet: 'Fetch a webpage and convert it to readable Markdown',
    parameters: Type.Object({
      url: Type.String({ description: 'The URL to fetch' }),
    }),
    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      const { url } = params;
      const turndownService = new TurndownService();

      // 1. Try local fetch
      const { data, contentType, statusCode, finalUrl } = await fetchContent(url, {}, signal);

      // Check for blocking/challenges
      const lowerData = data.toLowerCase();
      const isChallenge =
        statusCode === 403 ||
        statusCode === 429 ||
        statusCode === 503 ||
        lowerData.includes('challenge') ||
        lowerData.includes('captcha') ||
        lowerData.includes('cloudflare') ||
        lowerData.includes('just a moment...');

      let resultText: string | undefined;
      let source: FetchUrlSource = 'direct-text';
      const resolvedUrl = finalUrl;
      let resolvedContentType = contentType;
      let resolvedStatusCode = statusCode;
      let title: string | undefined;

      if (!isChallenge && statusCode >= 200 && statusCode < 300) {
        // 2. Process based on Content-Type
        if (contentType.includes('application/json')) {
          resultText = data;
          source = 'direct-json';
          title = extractMarkdownTitle(data);
        } else if (contentType.includes('text/plain')) {
          resultText = data;
          source = 'direct-text';
          title = extractMarkdownTitle(data);
        } else if (contentType.includes('text/markdown')) {
          resultText = data;
          source = 'direct-markdown';
          title = extractMarkdownTitle(data);
        } else if (contentType.includes('text/x-component')) {
          const rscText = parseRsc(data);
          if (rscText.length > 50) {
            resultText = rscText;
            source = 'rsc';
            title = extractMarkdownTitle(rscText);
          }
        } else if (contentType.includes('text/html')) {
          // 3. HTML -> Readability
          const doc = new JSDOM(data, { url: finalUrl });
          const reader = new Readability(doc.window.document);
          const article = reader.parse();

          if (article && article.content && article.content.length > 100) {
            // Convert to Markdown
            const markdown = turndownService.turndown(article.content);
            resultText = `# ${article.title}\n\n${markdown}`;
            source = 'readability';
            title = article.title || doc.window.document.title || undefined;
          } else {
            // 4. HTML -> Try to find RSC payload in scripts?
            const scripts = doc.window.document.querySelectorAll('script');
            for (const script of scripts) {
              if (script.textContent && script.textContent.includes('self.__next_f.push')) {
                const rscText = parseRsc(script.textContent);
                if (rscText.length > 50) {
                  resultText = rscText;
                  source = 'next-rsc';
                  title = extractMarkdownTitle(rscText) || doc.window.document.title || undefined;
                  break;
                }
              }
            }
          }
        }
      }

      // 5. Fallback: Jina Reader
      if (resultText === undefined) {
        const jinaUrl = `https://r.jina.ai/${url}`;
        const jinaResult = await fetchContent(jinaUrl, {}, signal);

        if (jinaResult.statusCode >= 200 && jinaResult.statusCode < 300) {
          // Check if Jina was also blocked
          const jinaLower = jinaResult.data.toLowerCase();
          if (
            jinaLower.includes('challenge') ||
            jinaLower.includes('captcha') ||
            jinaLower.includes('cloudflare') ||
            jinaLower.includes('just a moment...')
          ) {
            throw new Error(
              'Unable to fetch content due to access restrictions (Jina Reader also blocked). Please use the "agent-browser" tool to access this page.',
            );
          }

          resultText = jinaResult.data;
          source = 'jina-reader';
          title = extractMarkdownTitle(jinaResult.data);
          resolvedContentType = jinaResult.contentType || resolvedContentType;
          resolvedStatusCode = jinaResult.statusCode;
        } else {
          throw new Error(
            `Failed to fetch content via local parser and Jina Reader (Status: ${jinaResult.statusCode}). Please use the "agent-browser" tool.`,
          );
        }
      }

      const fullText = resultText;
      const fullContentLength = Buffer.byteLength(fullText, 'utf8');

      // Truncate output to avoid overwhelming the LLM context
      const truncation = truncateHead(fullText, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let outputText = truncation.content;
      let fullOutputPath: string | undefined;

      if (truncation.truncated) {
        try {
          fullOutputPath = await writeFullOutput('pi-fetch-url-', fullText, 'output.md');
        } catch (e) {
          console.warn('Failed to write full fetch_url output to temp file:', e);
        }

        const pathNote = fullOutputPath
          ? ` Full output saved to: ${fullOutputPath}`
          : ' Full output could not be saved.';

        outputText =
          truncation.content +
          `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).${pathNote}]`;
      }

      const details: FetchUrlToolDetails = {
        url,
        finalUrl: resolvedUrl,
        source,
        title,
        contentType: resolvedContentType,
        statusCode: resolvedStatusCode,
        contentLength: fullContentLength,
        fullOutputPath,
        truncation: truncation.truncated
          ? {
              truncated: true,
              outputLines: truncation.outputLines,
              totalLines: truncation.totalLines,
              outputBytes: truncation.outputBytes,
              totalBytes: truncation.totalBytes,
            }
          : undefined,
      };

      return {
        content: [{ type: 'text', text: outputText }],
        details,
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);
      text.setText(
        theme.fg('toolTitle', theme.bold('fetch_url ')) + theme.fg('accent', shortenUrlForDisplay(args.url, 84)),
      );
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);

      if (isPartial) {
        text.setText(theme.fg('warning', 'Fetching page…'));
        return text;
      }

      const details = result.details as FetchUrlToolDetails | undefined;
      if (!details) {
        const fallback = result.content[0];
        text.setText(fallback?.type === 'text' ? fallback.text : '');
        return text;
      }

      const rawText = result.content[0]?.type === 'text' ? result.content[0].text : '';
      const bodyText = stripRenderedTruncationNotice(rawText);
      const previewLines = getPreviewLines(
        bodyText,
        expanded ? 18 : 5,
        expanded ? 160 : 110,
        getPreviewMode(details.source),
      );
      const rawLineCount = bodyText.split('\n').filter((line) => line.trim()).length;
      const title = details.title || shortenUrlForDisplay(details.finalUrl || details.url, 100);

      const lines: string[] = [];
      lines.push(theme.fg('toolTitle', theme.bold(truncateText(title, 100))));

      let meta = theme.fg('accent', getDisplayHostname(details.finalUrl || details.url));
      meta += theme.fg('dim', ` • ${getSourceLabel(details.source)}`);
      if (details.contentType) {
        meta += theme.fg('dim', ` • ${truncateText(details.contentType.split(';')[0] || details.contentType, 32)}`);
      }
      meta += theme.fg('dim', ` • ${formatSize(details.contentLength)}`);
      if (details.statusCode > 0 && details.statusCode !== 200) {
        meta += theme.fg('dim', ` • HTTP ${details.statusCode}`);
      }
      if (details.finalUrl && details.finalUrl !== details.url) {
        meta += theme.fg('dim', ' • redirected');
      }
      lines.push(meta);

      if (expanded) {
        lines.push(theme.fg('dim', details.finalUrl));
      }

      if (previewLines.length > 0) {
        lines.push('');
        lines.push(...previewLines.map((line) => theme.fg('toolOutput', line)));
      }

      if (!expanded && rawLineCount > previewLines.length) {
        lines.push('');
        lines.push(theme.fg('dim', `... more content (${keyHint('app.tools.expand', 'to expand')})`));
      }

      if (expanded && rawLineCount > previewLines.length) {
        lines.push('');
        lines.push(theme.fg('dim', `Preview capped to ${previewLines.length} lines for readability.`));
      }

      if (details.truncation?.truncated) {
        lines.push('');
        lines.push(
          theme.fg(
            'warning',
            `[Tool output truncated: ${details.truncation.outputLines} of ${details.truncation.totalLines} lines (${formatSize(details.truncation.outputBytes)} of ${formatSize(details.truncation.totalBytes)})]`,
          ),
        );
      }

      if (details.fullOutputPath) {
        lines.push('');
        lines.push(theme.fg('dim', `Full output: ${details.fullOutputPath}`));
      }

      text.setText(lines.join('\n'));
      return text;
    },
  });
}
