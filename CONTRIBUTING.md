# Contributing

Thank you for considering a contribution to the open-source XVcache client, MCP server, and journal format.

This repository is being prepared for a public release. It has **not** been published yet. Please do not open a GitHub repository, publish an npm package, or submit the server to a directory on behalf of the project unless the maintainer has asked you to.

## Development

Requirements: Node.js 20 or later.

```bash
npm install
npm test
```

`npm test` builds the TypeScript, runs the MCP integration suite (`src/test-client.ts`, tests 1–20), and runs the isolated journal verdict test (`src/journal.test.ts`).

## Guidelines

- Keep the journal format backward-compatible unless a change is discussed first. The chain is: `hash = sha256(prev_hash + canonicalJson(payload))`, with a genesis `prev_hash` of 64 zero hex characters.
- `write_note` modes are `create` (default), `overwrite`, and `append`. Do not reintroduce a generic `write` mode.
- Environment variable `XVCACHE_VAULT` is required at runtime. `JAYCACHE_VAULT` remains a fallback alias; same for `XVCACHE_LOG` / `JAYCACHE_LOG`.
- Verdict wording for a note is **V** (intacte) or **X** (MODIFIÉE hors XVcache).
- Do not add network listeners, public ports, or credential storage.
- Do not commit vault contents, journals, keys, or `.env` files.
- The independent certifying witness is out of scope for this repository for now.

## License

Contributions are accepted under the Apache License, Version 2.0. The name XVcache is a trademark; see `TRADEMARK.md`.
