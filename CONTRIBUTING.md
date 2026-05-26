# Contributing

Tracebase changes should preserve the local-first privacy model and keep agent data useful without exposing hidden/private reasoning.

## Development

```sh
npm install
npm test
npm run test:stress
npm audit --omit=dev
```

Use `TRACE_HOME=$(mktemp -d)` when testing commands against disposable data.
`npm test` already includes the stress, UI, package, install, smoke, E2E, and release-audit gates; run the named subcommands directly when iterating on a focused area.

## Code Standards

- Keep storage append-only where possible.
- Prefer indexed SQLite queries for UI filters.
- Redact secrets from normalized API and CLI output.
- Never add network interception for trace content.
- Keep raw export paths explicit and user-initiated.
- Add smoke coverage for public CLI/API behavior.
