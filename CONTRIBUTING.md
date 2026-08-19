# Contributing

Thanks for helping improve `pi-codex-style-tools`.

## Quick flow

1. Open an issue for larger changes.
2. Create a branch from `main`.
3. Keep the change small and focused.
4. Run `npm run verify` and `npm run bench`.
5. Open a pull request describing the problem and solution.

## Standards

- Use TypeScript and the official Pi APIs.
- Keep tool execution delegated to Pi; this package only changes rendering.
- Add or update tests when behavior changes.
- Do not include secrets, `node_modules/`, or generated artifacts.

CI validates tests, types, packaging, the benchmark, and a real Pi installation.
