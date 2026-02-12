import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { USER_AGENT } from './utils.js';

// Helper to fetch URL content
function fetchContent(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  maxRedirects: number = 5,
): Promise<{ data: string; contentType: string; statusCode: number }> {
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
    description:
      'Fetch a URL and convert it to Markdown. Tries local HTML parsing (Readability), then RSC parsing, then falls back to Jina Reader. Returns the content directly.',
    parameters: Type.Object({
      url: Type.String({ description: 'The URL to fetch' }),
    }),
    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      const { url } = params;
      const turndownService = new TurndownService();

      try {
        // 1. Try local fetch
        const { data, contentType, statusCode } = await fetchContent(url, {}, signal);

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

        if (isChallenge) {
          // If blocked locally, try Jina immediately
          // console.log('Blocked locally, trying Jina...');
        } else if (statusCode >= 200 && statusCode < 300) {
          // 2. Process based on Content-Type
          if (
            contentType.includes('application/json') ||
            contentType.includes('text/plain') ||
            contentType.includes('text/markdown')
          ) {
            return { content: [{ type: 'text', text: data }] };
          }

          if (contentType.includes('text/x-component')) {
            const rscText = parseRsc(data);
            if (rscText.length > 50) {
              return { content: [{ type: 'text', text: rscText }] };
            }
          }

          if (contentType.includes('text/html')) {
            // 3. HTML -> Readability
            const doc = new JSDOM(data, { url });
            const reader = new Readability(doc.window.document);
            const article = reader.parse();

            if (article && article.content && article.content.length > 100) {
              // Convert to Markdown
              const markdown = turndownService.turndown(article.content);
              return {
                content: [
                  {
                    type: 'text',
                    text: `# ${article.title}\n\n${markdown}`,
                  },
                ],
              };
            }

            // 4. HTML -> Try to find RSC payload in scripts?
            const scripts = doc.window.document.querySelectorAll('script');
            for (const script of scripts) {
              if (script.textContent && script.textContent.includes('self.__next_f.push')) {
                const rscText = parseRsc(script.textContent);
                if (rscText.length > 50) {
                  return { content: [{ type: 'text', text: rscText }] };
                }
              }
            }
          }
        }

        // 5. Fallback: Jina Reader
        // console.log('Falling back to Jina Reader...');
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
            return {
              content: [
                {
                  type: 'text',
                  text: `Unable to fetch content due to access restrictions (Jina Reader also blocked).\nPlease use the "agent-browser" tool to access this page.`,
                },
              ],
              isError: true,
            };
          }

          return { content: [{ type: 'text', text: jinaResult.data }] };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to fetch content via local parser and Jina Reader (Status: ${jinaResult.statusCode}).\nPlease use the "agent-browser" tool.`,
              },
            ],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching URL: ${error instanceof Error ? error.message : String(error)}\n\nPlease try using the "agent-browser" tool to access this page.`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
