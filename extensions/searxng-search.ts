import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
  withFileMutationQueue,
  keyHint,
} from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@mariozechner/pi-ai';
import { Text } from '@mariozechner/pi-tui';
import { getDisplayHostname, summarizeHtmlText, summarizePlainText, truncateText, USER_AGENT } from './utils.js';

interface SearxngConfig {
  baseUrl: string;
  authType?: 'basic' | 'bearer';
  username?: string;
  password?: string;
  token?: string;
  headers?: Record<string, string>;
  defaultLanguage?: string;
  defaultCategories?: string;
  defaultEngines?: string;
  defaultSafesearch?: number;
  defaultTimeRange?: 'day' | 'week' | 'month' | 'year';
  defaultMaxResults?: number;
  timeout: number;
}

const DEFAULT_TIMEOUT_SECONDS = 30;

function getSearxngConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfigHome, 'agents', 'searxng.toml');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeCsvValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return parts.length > 0 ? parts.join(',') : undefined;
  }

  return normalizeString(value);
}

function resolveEnvReference(value: string | undefined, fieldName: string): string | undefined {
  if (!value || !value.startsWith('$')) {
    return value;
  }

  const variableName = value.startsWith('${') && value.endsWith('}') ? value.slice(2, -1) : value.slice(1);
  if (!variableName) {
    throw new Error(`Invalid environment variable reference in ${fieldName}.`);
  }

  const resolved = process.env[variableName];
  if (!resolved) {
    throw new Error(`Environment variable ${variableName} referenced by ${fieldName} is not set.`);
  }

  return resolved;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    const normalizedValue = normalizeString(headerValue);
    if (normalizedValue) {
      headers[key] = resolveEnvReference(normalizedValue, `headers.${key}`) ?? normalizedValue;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseSearxngConfig(rawConfig: unknown, configPath: string): SearxngConfig {
  const rootConfig = isRecord(rawConfig) ? rawConfig : {};

  const auth = isRecord(rootConfig.auth) ? rootConfig.auth : {};
  const authType = normalizeString(auth.type);
  if (authType && authType !== 'basic' && authType !== 'bearer') {
    throw new Error(`Unknown auth.type "${authType}" in ${configPath}. Use "bearer" or "basic".`);
  }

  const normalizedConfig: SearxngConfig = {
    baseUrl: normalizeString(rootConfig.base_url) ?? '',
    authType: authType as SearxngConfig['authType'],
    username: resolveEnvReference(normalizeString(auth.user), 'auth.user'),
    password: resolveEnvReference(normalizeString(auth.pass), 'auth.pass'),
    token: resolveEnvReference(normalizeString(auth.token), 'auth.token'),
    headers: normalizeHeaders(rootConfig.headers),
    defaultLanguage: normalizeString(rootConfig.default_language),
    defaultCategories: normalizeCsvValue(rootConfig.default_categories),
    defaultEngines: normalizeCsvValue(rootConfig.default_engines),
    defaultSafesearch: normalizeNumber(rootConfig.default_safesearch),
    defaultTimeRange: normalizeString(rootConfig.default_time_range) as SearxngConfig['defaultTimeRange'] | undefined,
    defaultMaxResults: normalizeNumber(rootConfig.default_max_results),
    timeout: normalizeNumber(rootConfig.timeout) ?? DEFAULT_TIMEOUT_SECONDS,
  };

  if (!normalizedConfig.baseUrl) {
    throw new Error(`base_url is required in ${configPath}.`);
  }

  return normalizedConfig;
}

function loadSearxngConfig(): { config: SearxngConfig; sourcePath?: string; expectedPath: string } {
  const configPath = getSearxngConfigPath();

  if (fs.existsSync(configPath)) {
    const rawToml = fs.readFileSync(configPath, 'utf8');
    return {
      config: parseSearxngConfig(toml.parse(rawToml), configPath),
      sourcePath: configPath,
      expectedPath: configPath,
    };
  }

  return {
    config: {
      baseUrl: '',
      timeout: DEFAULT_TIMEOUT_SECONDS,
    },
    expectedPath: configPath,
  };
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
  fullOutputPath?: string;
  truncation?: {
    truncated: boolean;
    outputLines: number;
    totalLines: number;
    outputBytes: number;
    totalBytes: number;
  };
}

function formatCount(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

async function writeFullOutput(prefix: string, content: string, filename: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const tempFile = path.join(tempDir, filename);
  await withFileMutationQueue(tempFile, async () => {
    await writeFile(tempFile, content, 'utf8');
  });
  return tempFile;
}

export default function (pi: ExtensionAPI) {
  let config: SearxngConfig = {
    baseUrl: '',
    timeout: DEFAULT_TIMEOUT_SECONDS,
  };
  let configSourcePath: string | undefined;
  let expectedConfigPath = getSearxngConfigPath();
  let configError: string | undefined;

  try {
    const loadedConfig = loadSearxngConfig();
    config = loadedConfig.config;
    configSourcePath = loadedConfig.sourcePath;
    expectedConfigPath = loadedConfig.expectedPath;
  } catch (e) {
    configError = e instanceof Error ? e.message : String(e);
    console.warn('Failed to read SearXNG config:', e);
  }

  pi.registerTool({
    name: 'web_search',
    label: 'Web Search (SearXNG)',
    description: `Search the web using a SearXNG instance. Returns search results with titles, URLs, and snippets. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, the full output is saved to a temp file and the path is returned.`,

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
      if (configError) {
        throw new Error(configError);
      }

      if (!config.baseUrl) {
        throw new Error(`SearXNG base URL is not configured. Expected shared config file at ${expectedConfigPath}.`);
      }

      const { query, categories, language, time_range, limit } = params;
      const effectiveCategories = categories ?? config.defaultCategories;
      const effectiveLanguage = language ?? config.defaultLanguage;
      const effectiveTimeRange = time_range ?? config.defaultTimeRange;
      const effectiveLimit = limit ?? config.defaultMaxResults ?? 10;
      const baseUrl = config.baseUrl.replace(/\/+$/, '');
      const searchUrl = new URL(`${baseUrl}/search`);

      searchUrl.searchParams.append('q', query);
      searchUrl.searchParams.append('format', 'json');

      if (effectiveCategories) {
        searchUrl.searchParams.append('categories', effectiveCategories);
      }

      if (config.defaultEngines) {
        searchUrl.searchParams.append('engines', config.defaultEngines);
      }

      if (effectiveLanguage) {
        searchUrl.searchParams.append('language', effectiveLanguage);
      }

      if (config.defaultSafesearch !== undefined) {
        searchUrl.searchParams.append('safesearch', `${config.defaultSafesearch}`);
      }

      if (effectiveTimeRange) {
        searchUrl.searchParams.append('time_range', effectiveTimeRange);
      }

      interface RequestHeaders {
        [key: string]: string | string[] | undefined;
      }

      const requestHeaders: RequestHeaders = {
        Accept: 'application/json',
        ...(config.headers || {}),
      };
      if (!requestHeaders['User-Agent'] && !requestHeaders['user-agent']) {
        requestHeaders['User-Agent'] = USER_AGENT;
      }

      const requestOptions: https.RequestOptions = {
        method: 'GET',
        signal,
        timeout: config.timeout * 1000,
        headers: requestHeaders,
      };

      // Handle authentication
      if (config.authType === 'basic') {
        if (!config.username || !config.password) {
          throw new Error(
            `auth.user and auth.pass are required when auth.type is "basic" in ${configSourcePath || expectedConfigPath}.`,
          );
        }

        const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
        (requestOptions.headers as RequestHeaders)['Authorization'] = `Basic ${auth}`;
      } else if (config.authType === 'bearer') {
        if (!config.token) {
          throw new Error(
            `auth.token is required when auth.type is "bearer" in ${configSourcePath || expectedConfigPath}.`,
          );
        }

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

        req.on('timeout', () => {
          req.destroy(new Error(`Request timed out after ${config.timeout}s`));
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
        .slice(0, effectiveLimit)
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

      const fullText = JSON.stringify(finalResponse, null, 2);

      // Truncate output to avoid overwhelming the LLM context
      const truncation = truncateHead(fullText, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let text = truncation.content;
      let fullOutputPath: string | undefined;

      if (truncation.truncated) {
        try {
          fullOutputPath = await writeFullOutput('pi-web-search-', fullText, 'output.json');
        } catch (e) {
          console.warn('Failed to write full web_search output to temp file:', e);
        }

        const pathNote = fullOutputPath
          ? ` Full output saved to: ${fullOutputPath}`
          : ' Full output could not be saved.';

        text =
          truncation.content +
          `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).${pathNote}]`;
      }

      return {
        content: [{ type: 'text', text }],
        details: {
          number_of_results:
            typeof jsonResponse.number_of_results === 'number' ? jsonResponse.number_of_results : undefined,
          ...finalResponse,
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
      let summaryLine = theme.fg('success', summary.join(' • '));
      if (details.truncation?.truncated) {
        summaryLine += theme.fg('warning', ' • truncated');
      }
      lines.push(summaryLine);

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

      if (details.fullOutputPath) {
        lines.push('');
        lines.push(theme.fg('dim', `Full output: ${details.fullOutputPath}`));
      }

      if (expanded && configSourcePath) {
        lines.push('');
        lines.push(theme.fg('dim', `Config: ${configSourcePath}`));
      }

      text.setText(lines.join('\n'));
      return text;
    },
  });
}
