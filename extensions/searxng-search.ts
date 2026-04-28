import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import toml from 'toml';
import { URL } from 'url';
import {
  ExtensionAPI,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
} from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@mariozechner/pi-ai';
import { Text } from '@mariozechner/pi-tui';
import { getDisplayHostname, summarizeHtmlText, summarizePlainText, truncateText, USER_AGENT } from './utils.js';

interface SearxngConfig {
  baseUrl: string;
  authType: 'none' | 'basic' | 'bearer';
  username?: string;
  password?: string;
  token?: string;
}

interface Answer {
  answer: string;
  url: string;
  title: string;
}

interface InfoboxAttribute {
  label: string;
  value: string;
}

interface InfoboxUrl {
  title: string;
  url: string;
}

interface Infobox {
  infobox: string;
  content: string;
  attributes: InfoboxAttribute[];
  urls: InfoboxUrl[];
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
  publishedDate: string;
  engine: string;
  score: number;
}

interface WebSearchAnswer {
  answer: string;
  url: string;
  title: string;
}

interface WebSearchInfobox {
  title: string;
  content: string;
  attributes: string[];
  urls: Array<{
    title: string;
    url: string;
  }>;
}

interface WebSearchResultItem {
  title: string;
  url: string;
  content: string;
  publishedDate: string;
  engine: string;
  score: number;
}

interface WebSearchToolDetails {
  query?: string;
  number_of_results?: number;
  answers?: WebSearchAnswer[];
  infoboxes?: WebSearchInfobox[];
  results: WebSearchResultItem[];
  suggestions?: string[];
}

function formatCount(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export default function (pi: ExtensionAPI) {
  // Default config
  let config: SearxngConfig = {
    baseUrl: '', // No default URL, must be configured
    authType: 'none',
  };

  // Read configuration from mypi.toml in the $PI_CODING_AGENT_DIR directory
  try {
    let agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir) {
      agentDir = path.join(os.homedir(), '.pi', 'agent');
    }

    const configPath = path.join(agentDir, 'mypi.toml');

    if (fs.existsSync(configPath)) {
      try {
        const tomlContent = fs.readFileSync(configPath, 'utf8');
        const parsedConfig = toml.parse(tomlContent);

        if (parsedConfig && parsedConfig.searxng) {
          // Map TOML keys to config object, converting snake_case to camelCase where needed
          const searxng = parsedConfig.searxng;
          config = {
            baseUrl: searxng.base_url || searxng.baseUrl || config.baseUrl,
            authType: searxng.auth_type || searxng.authType || config.authType,
            username: searxng.username,
            password: searxng.password,
            token: searxng.token,
          };
        }
      } catch (e) {
        console.warn(`Failed to parse mypi.toml from ${configPath}: ${e}`);
      }
    }
  } catch (e) {
    // Ignore errors reading config
    console.warn('Failed to read mypi.toml:', e);
  }

  pi.registerTool({
    name: 'web_search',
    label: 'Web Search (SearXNG)',
    description: 'Search the web using a SearXNG instance. Returns search results with titles, URLs, and snippets.',

    promptSnippet: 'Search the web using SearXNG for current information',
    parameters: Type.Object({
      query: Type.String({ description: 'The search query' }),
      categories: Type.Optional(
        Type.String({ description: 'Comma-separated list of categories (e.g., general, news, science)' }),
      ),
      language: Type.Optional(Type.String({ description: 'Search language (e.g., en-US, de-DE)' })),
      time_range: Type.Optional(
        StringEnum(['day', 'week', 'month', 'year'] as const, {
          description: 'Time range for results',
        }),
      ),
      limit: Type.Optional(Type.Number({ description: 'Number of results to return (default: 10)' })),
    }),

    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      if (!config.baseUrl) {
        throw new Error('SearXNG base URL is not configured. Please check mypi.toml.');
      }
      const { query, categories, language, time_range, limit } = params;
      const searchUrl = new URL('search', config.baseUrl);

      searchUrl.searchParams.append('q', query);
      searchUrl.searchParams.append('format', 'json');

      if (categories) {
        searchUrl.searchParams.append('categories', categories);
      }

      if (language) {
        searchUrl.searchParams.append('language', language);
      }

      if (time_range) {
        searchUrl.searchParams.append('time_range', time_range);
      }

      interface RequestHeaders {
        [key: string]: string | string[] | undefined;
      }

      const requestOptions: https.RequestOptions = {
        method: 'GET',
        signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        } as RequestHeaders,
      };

      // Handle authentication
      if (config.authType === 'basic' && config.username && config.password) {
        const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
        (requestOptions.headers as RequestHeaders)['Authorization'] = `Basic ${auth}`;
      } else if (config.authType === 'bearer' && config.token) {
        (requestOptions.headers as RequestHeaders)['Authorization'] = `Bearer ${config.token}`;
      }

      const data = await new Promise<string>((resolve, reject) => {
        const client = searchUrl.protocol === 'https:' ? https : http;

        const req = client.request(searchUrl.toString(), requestOptions, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`SearXNG request failed with status code ${res.statusCode}: ${data}`));
            }
          });
        });

        req.on('error', (e) => {
          reject(new Error(`Request failed: ${e.message}`));
        });

        if (signal?.aborted) {
          req.destroy();
          reject(new Error('Request aborted'));
        }

        req.end();
      });

      let jsonResponse: Record<string, unknown>;
      try {
        jsonResponse = JSON.parse(data);
      } catch (e) {
        throw new Error(`Failed to parse SearXNG response: ${e}`, { cause: e });
      }

      // Extract answers (direct answers like from Wikipedia)
      const answers = ((jsonResponse.answers as Answer[]) || []).map((a) => ({
        answer: a.answer,
        url: a.url,
        title: a.title || 'Answer',
      }));

      // Extract infoboxes (structured data)
      const infoboxes = ((jsonResponse.infoboxes as Infobox[]) || []).map((i) => ({
        title: i.infobox || 'Infobox',
        content: i.content,
        attributes: (i.attributes || []).map((attr) => `${attr.label}: ${attr.value}`),
        urls: (i.urls || []).map((u) => ({ title: u.title, url: u.url })),
      }));

      // Extract suggestions
      const suggestions = ((jsonResponse.suggestions as string[]) || []).slice(0, 8);

      // Format search results
      const formattedResults: WebSearchResultItem[] = ((jsonResponse.results as SearchResult[]) || [])
        .slice(0, limit || 10)
        .map((result) => ({
          title: result.title,
          url: result.url,
          content: result.content,
          publishedDate: result.publishedDate,
          engine: result.engine,
          score: result.score,
        }));

      const finalResponse: WebSearchToolDetails = {
        query: typeof jsonResponse.query === 'string' ? jsonResponse.query : query,
        answers: answers.length > 0 ? answers : undefined,
        infoboxes: infoboxes.length > 0 ? infoboxes : undefined,
        results: formattedResults,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      };

      let text = JSON.stringify(finalResponse, null, 2);

      // Truncate output to avoid overwhelming the LLM context
      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      if (truncation.truncated) {
        text =
          truncation.content +
          `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
      }

      return {
        content: [{ type: 'text', text }],
        details: {
          query: finalResponse.query,
          number_of_results:
            typeof jsonResponse.number_of_results === 'number' ? jsonResponse.number_of_results : undefined,
          ...finalResponse,
        },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);

      let content =
        theme.fg('toolTitle', theme.bold('web_search ')) + theme.fg('accent', `"${truncateText(args.query, 88)}"`);

      const filters: string[] = [];
      if (args.categories) {
        filters.push(args.categories);
      }
      if (args.language) {
        filters.push(args.language);
      }
      if (args.time_range) {
        filters.push(args.time_range);
      }
      if (args.limit !== undefined) {
        filters.push(`limit ${args.limit}`);
      }

      if (filters.length > 0) {
        content += `\n${theme.fg('dim', filters.join(' • '))}`;
      }

      text.setText(content);
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);

      if (isPartial) {
        text.setText(theme.fg('warning', 'Searching the web…'));
        return text;
      }

      const details = result.details as WebSearchToolDetails | undefined;
      if (!details) {
        const fallback = result.content[0];
        text.setText(fallback?.type === 'text' ? fallback.text : '');
        return text;
      }

      const answers = details.answers ?? [];
      const infoboxes = details.infoboxes ?? [];
      const results = details.results ?? [];
      const suggestions = details.suggestions ?? [];
      const lines: string[] = [];

      const summary: string[] = [];
      if (answers.length > 0) {
        summary.push(formatCount(answers.length, 'answer'));
      }
      if (infoboxes.length > 0) {
        summary.push(formatCount(infoboxes.length, 'infobox'));
      }
      summary.push(formatCount(results.length, 'result'));
      if (suggestions.length > 0) {
        summary.push(formatCount(suggestions.length, 'suggestion'));
      }
      if (typeof details.number_of_results === 'number' && details.number_of_results > results.length) {
        summary.push(`~${details.number_of_results} total`);
      }
      lines.push(theme.fg('success', summary.join(' • ')));

      if (answers.length > 0) {
        const firstAnswer = answers[0]!;
        const preview = summarizePlainText(firstAnswer.answer, expanded ? 240 : 140);
        if (preview) {
          lines.push(`${theme.fg('accent', 'Answer')} ${theme.fg('text', preview)}`);
        }
      }

      if (expanded && infoboxes.length > 0) {
        const firstInfobox = infoboxes[0]!;
        const title = summarizePlainText(firstInfobox.title, 100);
        const contentPreview = summarizeHtmlText(firstInfobox.content, 220);
        if (title) {
          lines.push(`${theme.fg('accent', 'Infobox')} ${theme.fg('text', title)}`);
        }
        if (contentPreview) {
          lines.push(theme.fg('toolOutput', contentPreview));
        }
        for (const attribute of firstInfobox.attributes.slice(0, 3)) {
          lines.push(theme.fg('dim', `• ${summarizePlainText(attribute, 140)}`));
        }
      }

      const visibleResults = expanded ? results.slice(0, 8) : results.slice(0, 3);
      for (const [index, item] of visibleResults.entries()) {
        const title = summarizeHtmlText(item.title, expanded ? 120 : 90) || truncateText(item.url, 90);
        const snippet = summarizeHtmlText(item.content, expanded ? 220 : 140);

        let meta = theme.fg('muted', getDisplayHostname(item.url));
        if (item.engine) {
          meta += theme.fg('dim', ` • ${item.engine}`);
        }
        if (item.publishedDate) {
          meta += theme.fg('dim', ` • ${truncateText(item.publishedDate, 40)}`);
        }

        lines.push('');
        lines.push(`${theme.fg('toolTitle', `${index + 1}.`)} ${theme.fg('accent', title)}`);
        lines.push(meta);
        if (snippet) {
          lines.push(theme.fg('toolOutput', snippet));
        }
      }

      if (!expanded && results.length > visibleResults.length) {
        lines.push('');
        lines.push(
          theme.fg(
            'dim',
            `... +${results.length - visibleResults.length} more (${keyHint('app.tools.expand', 'to expand')})`,
          ),
        );
      }

      if (expanded && suggestions.length > 0) {
        lines.push('');
        lines.push(theme.fg('muted', `Suggestions: ${suggestions.map((item) => truncateText(item, 32)).join(' • ')}`));
      }

      text.setText(lines.join('\n'));
      return text;
    },
  });
}
