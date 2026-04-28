# mypi Project Knowledge Base

**Generated:** Thu Feb 12 2026 13:36:29 GMT+0800
**Commit:** 0fa4615
**Branch:** master

## Overview

mypi is a **pi-package** project—an extension system for the pi framework (pi-ai, pi-coding-agent). It provides a SearXNG web search extension that integrates with the PI coding agent system.

**Core Stack:** TypeScript 5.9.3 • ES2022 • Node.js • TypeBox • TOML

---

## Structure

```
.
├── extensions/              # PI extensions
│   ├── fetch-url.ts         # URL fetcher
│   └── searxng-search.ts    # Web search via SearXNG
├── .pi/                     # PI agent data
│   └── todos/
├── package.json             # pi-package manifest
├── tsconfig.json            # ES2022 + strict mode
├── eslint.config.mjs        # TypeScript ESLint + Prettier
├── searxng.example.toml     # Shared SearXNG configuration example
└── pnpm-lock.yaml
```

---

## Where to Look

| Task             | Location                        | Notes                                                                                                   |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Add extension    | `extensions/*.ts`               | Export default function receives `ExtensionAPI`                                                         |
| Configure        | `~/.config/agents/searxng.toml` | Shared with [skills/searxng-search](https://github.com/XYenon/agents/tree/master/skills/searxng-search) |
| Type definitions | `@mariozechner/pi-coding-agent` | Peer dependency providing `ExtensionAPI`                                                                |
| Validation       | `@sinclair/typebox`             | Runtime type validation for tool parameters                                                             |

---

## Extension Pattern

Extensions export a default function that receives an `ExtensionAPI`:

```typescript
import { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'tool_name',
    label: 'Human Label',
    description: 'What this tool does',
    parameters: Type.Object({
      param: Type.String({ description: 'Parameter description' }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Implementation
      return { content: [{ type: 'text', text: 'result' }] };
    },
  });
}
```

**Key Points:**

- Always use `@sinclair/typebox` for parameter validation
- Tool names use `snake_case`
- Return type follows PI's content format
- Configuration via shared SearXNG TOML file in the XDG config directory

---

## Conventions

### Code Style

- **Quotes:** Single quotes (Prettier enforced)
- **Semicolons:** Always required
- **Trailing commas:** All (multiline)
- **Print width:** 120 characters
- **Tab width:** 2 spaces

### TypeScript

- **Target:** ES2022
- **Module:** ESNext
- **Module resolution:** Bundler
- **Strict mode:** Enabled
- **Skip lib check:** true

### Naming

- **Files:** kebab-case (e.g., `searxng-search.ts`)
- **Functions:** camelCase
- **Types/Interfaces:** PascalCase
- **Parameters:** camelCase with descriptive names

---

## Commands

```bash
# Install dependencies
pnpm install

# Lint code
pnpm run lint

# Fix linting issues
pnpm run lint:fix

# Format code
pnpm run format
```

---

## Configuration

Configuration is read from the shared SearXNG config file:

- `$XDG_CONFIG_HOME/agents/searxng.toml`
- default path: `~/.config/agents/searxng.toml`

This is the same file used by the [skills/searxng-search](https://github.com/XYenon/agents/tree/master/skills/searxng-search).

```toml
base_url = "https://searx.be"
default_categories = ["general"]
default_max_results = 10

# [auth]
# type = "bearer"
# token = "$SEARXNG_TOKEN"
```

**Supported config fields:**

- `base_url`
- `[auth]` with `type = "bearer"` + `token`
- `[auth]` with `type = "basic"` + `user` / `pass`
- `[headers]`
- `default_language`
- `default_categories`
- `default_engines`
- `default_safesearch`
- `default_time_range`
- `default_max_results`
- `timeout`

---

## Dependencies

**Runtime:**

- `toml`: ^3.0.0 (TOML parsing)

**Peer Dependencies:**

- `@mariozechner/pi-ai`: Extension API
- `@mariozechner/pi-coding-agent`: Coding agent API
- `@sinclair/typebox`: Runtime type validation

**Development:**

- TypeScript 5.9.3
- ESLint + TypeScript-ESLint
- Prettier

---

## Notes

- **No tests present**: The project currently has no test files
- **Extensions**:
  - `searxng-search`: Web search via SearXNG (requires configuration)
  - `fetch-url`: URL fetcher with smart fallback (Local HTML/RSC -> Jina Reader)
- **Configuration required**: SearXNG base URL must be configured in the shared `searxng.toml` file before use
- **Error handling**: Uses try/catch with console.warn for config parsing failures
- **PI framework**: This package is designed to run within the PI coding agent environment
