# mypi

`mypi` is a personalized [pi-package](https://github.com/mariozechner/pi-coding-agent) project for the **pi coding agent** framework. It provides custom tools, extensions, and a collection of curated plugins to enhance your AI coding experience.

## Features

### Custom Extensions

- **SearXNG Web Search (`searxng-search.ts`)**: Integrates web search capabilities via a self-hosted or public SearXNG instance. Supports categories, engines, time range, and language filters.
- **Fetch URL (`fetch-url.ts`)**: A robust URL fetcher with smart parsing fallbacks (Local HTML/Readability -> Turndown), fetching web content and converting it to Markdown for the agent to read.

### Bundled Plugins & Integrations

This package also bundles and automatically loads several powerful pi plugins:

- **[mitsupi](https://github.com/mariozechner/mitsupi)**: Provides utility extensions such as `context`, `multi-edit`, `notify`, and `review`.
- **[pi-mcp-adapter](https://github.com/mariozechner/pi-mcp-adapter)**: Connects to Model Context Protocol (MCP) servers.
- **[pi-powerline-footer](https://github.com/mariozechner/pi-powerline-footer)**: Enhances the TUI with a powerline-style status footer.
- **[pi-rewind-hook](https://github.com/mariozechner/pi-rewind-hook)**: Allows rewinding session state.
- **[pi-skill-palette](https://github.com/mariozechner/pi-skill-palette)**: A command palette for quickly discovering and invoking skills.
- **[pi-subagents](https://github.com/mariozechner/pi-subagents)**: Enables workflows delegating tasks to builtin or custom subagents.
- **[pi-catppuccin](https://github.com/XYenon/catppuccin-pi-coding-agent)**: Beautiful Catppuccin themes for the TUI.

## Installation

You can install this package globally or locally in your project using the `pi` CLI.

```bash
pi install https://github.com/XYenon/mypi
```

By default, `pi install` writes to your global settings. If you want to install it just for a specific project, append the `-l` flag:
```bash
pi install -l https://github.com/XYenon/mypi
```

## Configuration

### SearXNG Search

The `searxng-search` extension requires configuration to point to a SearXNG instance. The configuration is read from:

`~/.config/agents/searxng.toml`

An example configuration is provided in `searxng.example.toml`:

```toml
base_url = "https://searx.be"
default_categories = ["general"]
default_max_results = 10
timeout = 10000

# Optional Authentication
# [auth]
# type = "bearer"
# token = "YOUR_SEARXNG_TOKEN"
```

## Development

The project uses TypeScript, ESLint, and Prettier.

```bash
# Install dependencies
pnpm install

# Lint code
pnpm run lint

# Format code
pnpm run format
```

## License

This project is licensed under the [AGPL-3.0 License](LICENSE).
