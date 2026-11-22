# Directory submissions (do not submit yet)

Nothing in this file has been submitted. Publishing to npm, creating a GitHub repository, or listing XVcache in a registry needs Julien's explicit approval.

Official format and process (verified 22 November 2026, Europe/Paris):

- Schema: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
- `server.json` specification: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md
- Official registry extra rules: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md
- Publish quickstart: https://modelcontextprotocol.io/registry/quickstart
- Registry API: https://registry.modelcontextprotocol.io
- Registry about: https://modelcontextprotocol.io/registry/about

This repo already contains a `server.json` template. Before a real publish:

1. Replace `io.github.REPLACE-ME/xvcache` in `server.json` and the `mcpName` field in `package.json` with a namespace you control (GitHub auth requires `io.github.<user-or-org>/…`; a custom domain uses DNS proof).
2. Add a `repository` URL once the GitHub repo exists (optional in the schema, expected by several directories).
3. Publish the `xvcache-mcp` package to npm (`mcpName` must match `server.json` `name`).
4. Install `mcp-publisher`, run `mcp-publisher init` only if you need to refresh the template, then `mcp-publisher login github` and `mcp-publisher publish`.
5. Confirm with: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.REPLACE-ME/xvcache"` (using the real name).

The official registry is in preview; breaking changes or data resets may occur.

`description` in `server.json` must be 1–100 characters. The current text is 86 characters:

> Tamper-evident Markdown vault journal. Verdicts: V intact, X modified outside XVcache.

## Suggested listing text (directories that allow a longer blurb)

English:

> XVcache is a local STDIO MCP server that journals reads and writes in a Markdown vault as a sha256-chained JSONL log. verify_journal returns V when a note is intact, or X when it was modified outside XVcache, without putting the note's content in the journal. Slogan: J'ai caché, j'ai prouvé. Agents can also list plans and request a human-approved upgrade; payment is not live and prices are TBD. The independent certifying witness is à venir.

Français:

> « J'ai caché, j'ai prouvé. » XVcache est un serveur MCP local (STDIO) qui journalise les lectures et écritures d'un coffre Markdown dans un journal JSONL chaîné par sha256. L'outil verify_journal rend le verdict V (intacte) ou X (MODIFIÉE hors XVcache), sans exposer le contenu de la note. Les agents peuvent lister les offres et demander l'accord d'un humain pour un passage payant : aucun paiement n'est en service, les prix sont des placeholders TBD. Le témoin certificateur indépendant est à venir.

## Checklist of directories (HTTP-verified 22 November 2026, Europe/Paris)

Submit nothing until Julien approves each line. Prefer the official registry first; several directories ingest it.

| Directory | URL | What it needs | Notes |
|---|---|---|---|
| Official MCP Registry | https://registry.modelcontextprotocol.io — docs: https://modelcontextprotocol.io/registry/quickstart | Public GitHub (for `io.github.*` namespace) or DNS for a domain namespace; npm package `xvcache-mcp` with matching `mcpName`; `server.json`; `mcp-publisher login` + `publish`. | Source of record. Preview. Hosts metadata only, not the package. |
| Glama | https://glama.ai/mcp/servers — how to submit: https://glama.ai/mcp/faq | GitHub repository URL, display name, short description. “Add MCP Server” on the servers page. | FAQ states Glama also syncs Streamable HTTP servers published to the official registry on an hourly schedule. This project is STDIO-only today, so a GitHub submission is the path. |
| mcp.so | https://mcp.so/submit (directory: https://mcp.so) | GitHub repository URL (required for an MCP Server listing) and project name. | Paid listing is advertised as a one-time USD 39 fee for immediate publish / verified badge. Confirm the current free-vs-paid options on the form before paying. Do not pay without approval. |
| PulseMCP | https://www.pulsemcp.com/submit (directory: https://www.pulsemcp.com/servers/) | Today: publish to the official registry instead of a direct submit. | Submissions and listing changes are paused (page last updated 3 September 2026). The site says it will pick up official-registry servers when it is back. |
| MCP Market | https://mcpmarket.com/submit (directory: https://mcpmarket.com) | Use the site's submit form (form fields not copied here; re-read the page at submission time). | Submit URL returned HTTP 200 on the check date. |
| Smithery | https://smithery.ai (redirects to https://www.smithery.ai/) | Unclear. | Still a public directory after its connection proxy shut down on 31 October 2026. No reliable public submission flow was confirmed on the homepage check. Revisit before any attempt. |

`cursor.directory` was not added: a public HTTP check returned HTTP 429 at verification time, so its current MCP listing flow was not confirmed.

## Name placeholders to resolve before any submit

- GitHub user or org, and repository name (see the decisions list in the maintainer notes).
- npm package: prepared as `xvcache-mcp` (also check that `xvcache` stays unused if you want to reserve it).
- MCP registry name: `io.github.<account>/xvcache` once the account exists.
