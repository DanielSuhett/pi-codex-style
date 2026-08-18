# pi-codex-style-tools

A Pi extension that keeps the built-in tools unchanged but renders them like
Codex CLI: inline bullets, `Running`/`Ran` labels, shell highlighting, `│` and
`└` gutters, compact output previews, and expandable details.

## Install globally

Copy this directory to `~/.pi/agent/extensions/codex-style/`, then restart Pi
(or use `/reload`). Pi discovers `index.ts` automatically.

## Test without installing

```bash
pi -e ./index.ts
```

The extension overrides only the visual renderer for `bash`, `read`, `grep`,
`find`, `ls`, `edit`, and `write`; execution remains delegated to Pi's original
built-in implementations.

Consecutive calls of the same file operation are grouped into one row. Read
and grep previews stay inline; read content gets a bordered, path-aware syntax
highlight with a 10-line preview and expansion hint. Short diffs up to 20
lines are shown inline; longer diffs remain available through expansion. Bash
output follows the tail (up to 10 lines), omits empty results, and highlights
Git insertions in green and deletions in red.
