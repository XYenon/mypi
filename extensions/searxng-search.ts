import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import toml from 'toml';
import { URL } from 'url';
import { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const USER_AGENT = `${pkg.name}/${pkg.version} (+https://github.com/XYenon/mypi)`;

interface SearxngConfig {
  baseUrl: string;
  authType: 'none' | 'basic' | 'bearer';
  username?: string;
  password?: string;
  token?: string;
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

    parameters: Type.Object({
      query: Type.String({ description: 'The search query' }),
      categories: Type.Optional(
        Type.String({ description: 'Comma-separated list of categories (e.g., general, news, science)' }),
      ),
      language: Type.Optional(Type.String({ description: 'Search language (e.g., en-US, de-DE)' })),
      time_range: Type.Optional(
        Type.Union([Type.Literal('day'), Type.Literal('week'), Type.Literal('month'), Type.Literal('year')], {
          description: 'Time range for results',
        }),
      ),
      limit: Type.Optional(Type.Number({ description: 'Number of results to return (default: 10)' })),
    }),

    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      if (!config.baseUrl) {
        return {
          content: [{ type: 'text', text: 'Error: SearXNG base URL is not configured. Please check mypi.toml.' }],
          isError: true,
          details: {},
        };
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
        searchUrl.searchParams.append('time_range', time_range as string);
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

      return new Promise((resolve, reject) => {
        const client = searchUrl.protocol === 'https:' ? https : http;

        const req = client.request(searchUrl.toString(), requestOptions, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const jsonResponse = JSON.parse(data);

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

                // Extract answers (direct answers like from Wikipedia)
                const answers = (jsonResponse.answers || []).map((a: Answer) => ({
                  answer: a.answer,
                  url: a.url,
                  title: a.title || 'Answer',
                }));

                // Extract infoboxes (structured data)
                const infoboxes = (jsonResponse.infoboxes || []).map((i: Infobox) => ({
                  title: i.infobox || 'Infobox',
                  content: i.content,
                  attributes: (i.attributes || []).map((attr: InfoboxAttribute) => `${attr.label}: ${attr.value}`),
                  urls: (i.urls || []).map((u: InfoboxUrl) => ({ title: u.title, url: u.url })),
                }));

                // Extract suggestions
                const suggestions = (jsonResponse.suggestions || []).slice(0, 8);

                // Format search results
                const formattedResults = (jsonResponse.results || [])
                  .slice(0, limit || 10)
                  .map((result: SearchResult) => ({
                    title: result.title,
                    url: result.url,
                    content: result.content,
                    publishedDate: result.publishedDate,
                    engine: result.engine,
                    score: result.score,
                  }));

                const finalResponse = {
                  query: jsonResponse.query,
                  answers: answers.length > 0 ? answers : undefined,
                  infoboxes: infoboxes.length > 0 ? infoboxes : undefined,
                  results: formattedResults,
                  suggestions: suggestions.length > 0 ? suggestions : undefined,
                };

                resolve({
                  content: [{ type: 'text', text: JSON.stringify(finalResponse, null, 2) }],
                  details: {
                    query: jsonResponse.query,
                    number_of_results: jsonResponse.number_of_results,
                    ...finalResponse,
                  },
                });
              } catch (e) {
                reject(new Error(`Failed to parse SearXNG response: ${e}`));
              }
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
    },
  });
}
