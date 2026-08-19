# pi-codex-style-tools

> Codex-like inline rendering for Pi's built-in tools.

[![CI](https://github.com/DanielSuhett/pi-codex-style/actions/workflows/ci.yml/badge.svg)](https://github.com/DanielSuhett/pi-codex-style/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`pi-codex-style-tools` is a Pi package that keeps tool execution unchanged
while rendering it with a Codex-like presentation: inline bullets, `Running`/`Ran`
labels, shell highlighting, `│` and `└` gutters, compact output previews, and
expandable details. Search results from extensions are normalized to source URLs.

## Installation

After the package is published to npm:

```bash
pi install npm:pi-codex-style-tools
```

Or install it directly from the public repository:

```bash
pi install git:github.com/DanielSuhett/pi-codex-style
```

For local development:

```bash
pi -e ./index.ts
```

Restart Pi or run `/reload` after installing the package.

## What it changes

The extension overrides only the visual renderer for `bash`, `read`, `grep`,
`find`, `ls`, `edit`, and `write`. Tool execution remains delegated to Pi's
original built-in implementations. Search-like tool results from extensions are
compactly rewritten to source links while preserving their details.

- Consecutive file operations are grouped into one row.
- Grep previews stay inline.
- Short diffs up to 20 lines are shown inline; longer diffs remain expandable.
- Bash output follows the tail, up to 10 lines, and highlights Git statistics.
- Empty successful output stays hidden to keep the transcript compact.
- Search results from Firecrawl, Tavily, Brave, SerpAPI, and similar tools show only source URLs.

## Performance

Renderer output is cached by tool result and theme. Syntax highlighting is
limited to the visible read preview, and expanded output is capped at 200 lines
with an expansion hint. This keeps repeated TUI redraws cheap and avoids large
tool results blocking Pi's event loop.

## Development

Requirements: Node.js `>=22.6.0`, npm, and a compatible Pi installation.

```bash
npm ci
npm run verify
```

Run the Pi-hosted renderer benchmark separately:

```bash
npm run bench
```

The benchmark reports cold and steady render times for the overridden tools and
event-loop lag.

## Package structure

```text
index.ts                 Pi extension entry point
bench/renderer-bench.ts  renderer benchmark
.github/workflows/ci.yml tests, types, packaging, and Pi installation smoke test
```

The package manifest declares `index.ts` under `pi.extensions`, includes the
`pi-package` keyword for package discovery, and keeps Pi core packages as peer
dependencies as required by the Pi package documentation.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow and
standards. The project also includes a code of conduct and issue templates.

## Security

See [`SECURITY.md`](SECURITY.md) for private vulnerability reporting.

## License

[MIT](LICENSE) © 2026 Suhett.
