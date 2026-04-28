import { initTheme } from '@mariozechner/pi-coding-agent';
import { KeybindingsManager as AppKeybindingsManager } from '../node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { setKeybindings, type Component } from '@mariozechner/pi-tui';
import fetchUrlExtension from '../extensions/fetch-url.ts';
import webSearchExtension from '../extensions/searxng-search.ts';

interface PreviewTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  inverse(text: string): string;
  strikethrough(text: string): string;
}

interface PreviewRenderContext {
  args: Record<string, unknown>;
  state: Record<string, unknown>;
  lastComponent?: Component;
  invalidate(): void;
  toolCallId: string;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

interface PreviewToolResult {
  content: Array<{
    type: string;
    text?: string;
  }>;
  details?: unknown;
}

interface PreviewRenderResultOptions {
  expanded: boolean;
  isPartial: boolean;
}

interface PreviewTool {
  name: string;
  renderCall?: (args: Record<string, unknown>, theme: PreviewTheme, context: PreviewRenderContext) => Component;
  renderResult?: (
    result: PreviewToolResult,
    options: PreviewRenderResultOptions,
    theme: PreviewTheme,
    context: PreviewRenderContext,
  ) => Component;
}

interface PreviewCase {
  tool: string;
  name: string;
  render(): Component;
}

const width = getNumberArg('--width', 100);
const toolFilter = getStringArg('--tool');
const tools = new Map<string, PreviewTool>();

const plainTheme: PreviewTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  inverse: (text) => text,
  strikethrough: (text) => text,
};

const fakePi = {
  registerTool(tool: PreviewTool) {
    tools.set(tool.name, tool);
  },
} as unknown as ExtensionAPI;

initTheme('dark', false);
setKeybindings(new AppKeybindingsManager());

webSearchExtension(fakePi);
fetchUrlExtension(fakePi);

const webSearchArgs = {
  query: 'rust web framework benchmark',
  categories: 'general,science',
  language: 'en-US',
  time_range: 'month',
  limit: 5,
};

const webSearchResult: PreviewToolResult = {
  content: [{ type: 'text', text: 'preview' }],
  details: {
    query: 'rust web framework benchmark',
    number_of_results: 123,
    answers: [
      {
        title: 'Answer',
        url: 'https://example.com/answer',
        answer: 'Actix and Axum are the two Rust web frameworks most often compared in current benchmark roundups.',
      },
    ],
    infoboxes: [
      {
        title: 'Axum',
        content: '<p>Axum is a Rust web framework focused on ergonomics and modularity.</p>',
        attributes: ['Language: Rust', 'Maintainer: Tokio project', 'Style: Tower-based middleware'],
        urls: [{ title: 'Docs', url: 'https://docs.rs/axum' }],
      },
    ],
    results: [
      {
        title: 'Actix &amp; Axum benchmark results <b>2026</b>',
        url: 'https://bench.example.com/actix-axum-2026',
        content:
          'A comparison of <em>throughput</em>, latency, and memory usage across common Rust web frameworks under realistic API workloads.',
        publishedDate: '2026-04-01',
        engine: 'duckduckgo',
        score: 1,
      },
      {
        title: 'Rust web framework performance roundup',
        url: 'https://blog.example.com/rust-web-performance',
        content:
          'We compare Actix, Axum, Warp, and Rocket in mixed JSON and database-backed scenarios, highlighting tail latency trade-offs.',
        publishedDate: '2026-03-15',
        engine: 'google',
        score: 0.9,
      },
      {
        title: 'Independent benchmark: Axum vs Warp vs Rocket',
        url: 'https://perf.example.org/rust-frameworks',
        content:
          'Independent benchmark with reproducible scripts covering hello-world endpoints and middleware-heavy services.',
        publishedDate: '2026-03-02',
        engine: 'bing',
        score: 0.81,
      },
      {
        title: 'How to benchmark Rust HTTP servers correctly',
        url: 'https://infra.example.net/blog/rust-http-benchmarking',
        content:
          'Methodology notes on warmup, connection reuse, percentile reporting, and avoiding misleading hello-world charts.',
        publishedDate: '2026-02-20',
        engine: 'qwant',
        score: 0.72,
      },
    ],
    suggestions: ['axum benchmark', 'actix benchmark', 'rust http benchmark methodology'],
  },
};

const fetchUrlArgs = {
  url: 'https://example.com/blog/rust-web-benchmarks-2026',
};

const fetchUrlContent = `# Rust Web Benchmarks in 2026

Actix and Axum remain the two most frequently compared Rust frameworks for high-throughput APIs.

This article evaluates latency under mixed workloads instead of relying on hello-world routes only.

The benchmark suite includes middleware, JSON serialization, and connection pooling overhead.

In realistic CRUD traffic, Axum stays close to Actix while offering a more modular developer experience.

The conclusion is that benchmark methodology matters more than any single headline number.

You should always validate performance against your own traffic profile before picking a framework.`;

const fetchUrlResult: PreviewToolResult = {
  content: [{ type: 'text', text: fetchUrlContent }],
  details: {
    url: 'https://example.com/blog/rust-web-benchmarks-2026',
    finalUrl: 'https://example.com/blog/rust-web-benchmarks-2026',
    source: 'readability',
    title: 'Rust Web Benchmarks in 2026',
    contentType: 'text/html; charset=utf-8',
    statusCode: 200,
    contentLength: 10240,
  },
};

const previewCases: PreviewCase[] = [
  {
    tool: 'web_search',
    name: 'web_search / call',
    render: () => renderToolCall('web_search', webSearchArgs),
  },
  {
    tool: 'web_search',
    name: 'web_search / result / collapsed',
    render: () => renderToolResult('web_search', webSearchResult, { expanded: false, isPartial: false }, webSearchArgs),
  },
  {
    tool: 'web_search',
    name: 'web_search / result / expanded',
    render: () => renderToolResult('web_search', webSearchResult, { expanded: true, isPartial: false }, webSearchArgs),
  },
  {
    tool: 'fetch_url',
    name: 'fetch_url / call',
    render: () => renderToolCall('fetch_url', fetchUrlArgs),
  },
  {
    tool: 'fetch_url',
    name: 'fetch_url / result / collapsed',
    render: () => renderToolResult('fetch_url', fetchUrlResult, { expanded: false, isPartial: false }, fetchUrlArgs),
  },
  {
    tool: 'fetch_url',
    name: 'fetch_url / result / expanded',
    render: () => renderToolResult('fetch_url', fetchUrlResult, { expanded: true, isPartial: false }, fetchUrlArgs),
  },
];

const visibleCases = toolFilter ? previewCases.filter((item) => item.tool === toolFilter) : previewCases;

if (visibleCases.length === 0) {
  console.error(`No preview cases found for tool: ${toolFilter}`);
  process.exit(1);
}

const visibleTools = [...new Set(visibleCases.map((item) => item.tool))];

console.log(`# Renderer preview`);
console.log(`width: ${width}`);
console.log(`tools: ${visibleTools.join(', ')}`);
console.log(`hint: pnpm preview:renderers -- --tool web_search --width 120`);
console.log('');

for (const previewCase of visibleCases) {
  const component = previewCase.render();
  printBlock(previewCase.name, component, width);
}

function renderToolCall(toolName: string, args: Record<string, unknown>): Component {
  const tool = tools.get(toolName);
  if (!tool?.renderCall) {
    throw new Error(`Tool ${toolName} does not expose renderCall()`);
  }

  return tool.renderCall(args, plainTheme, createContext({ args }));
}

function renderToolResult(
  toolName: string,
  result: PreviewToolResult,
  options: PreviewRenderResultOptions,
  args: Record<string, unknown>,
): Component {
  const tool = tools.get(toolName);
  if (!tool?.renderResult) {
    throw new Error(`Tool ${toolName} does not expose renderResult()`);
  }

  return tool.renderResult(result, options, plainTheme, createContext({ args, expanded: options.expanded }));
}

function createContext(overrides: Partial<PreviewRenderContext> = {}): PreviewRenderContext {
  return {
    args: {},
    state: {},
    invalidate() {},
    toolCallId: 'preview',
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

function printBlock(title: string, component: Component, renderWidth: number): void {
  console.log(`=== ${title} ===`);
  console.log(stripAnsi(component.render(renderWidth).join('\n')));
  console.log('');
}

function stripAnsi(text: string): string {
  let result = '';

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\u001b' && text[index + 1] === '[') {
      index += 2;
      while (index < text.length && text[index] !== 'm') {
        index++;
      }
      continue;
    }

    result += char;
  }

  return result;
}

function getStringArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function getNumberArg(flag: string, fallback: number): number {
  const value = getStringArg(flag);
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value for ${flag}: ${value}`);
  }

  return parsed;
}
