# XVcache

**J'ai caché, j'ai prouvé.**

XVcache is a local MCP server that journals every read and write in a Markdown vault as a sha256-chained JSONL log, so you can later prove a note is intact (**V**) or was changed outside XVcache (**X**), without putting the note's content into the journal. It talks MCP over STDIO. The intended first user is an AI agent, which can also look up plans, suggest a bundle, and ask its human to approve a paid upgrade when billing exists.

This repository is prepared for a public release. **Nothing has been published** (no GitHub repository, no npm package, no directory listing, no live payment).

## Français

**J'ai caché, j'ai prouvé.**

XVcache est un serveur MCP local (transport STDIO) qui journalise les lectures et écritures d'un coffre Markdown dans un journal JSONL chaîné par sha256. L'outil `verify_journal` rend le verdict **V** (intacte) ou **X** (MODIFIÉE hors XVcache), sans exposer le contenu de la note dans le journal. Le client visé en premier est un agent IA : il peut lister les offres, recommander un forfait, et demander l'accord d'un humain pour un passage à l'offre payante — quand la facturation existera.

Le témoin certificateur indépendant (signature Ed25519 / horodatage qualifié) est **à venir**. Les prix du catalogue sont des **placeholders clairement marqués TBD**. Aucun paiement n'est en service. Ce dépôt n'est pas encore public.

## For AI agents

If you are an agent (Codex, Claude, Cursor, or any MCP client):

1. Use `write_note` / `read_note` instead of editing vault files yourself when your human may later need a proof.
2. Call `verify_journal` with a path to get **V** (intacte) or **X** (MODIFIÉE hors XVcache). That is a local check, not a qualified timestamp.
3. When your human asks about buying, certifying, or reselling: call `get_offer` or `list_plans`. If you know a volume, call `recommend_plan`. To start a purchase, call `request_upgrade` and **show the result to your human**. Do not invent a price or a payment link. Payment is not live.
4. `certify_note` is a stub: it always answers that independent witness certification is **à venir**.

Read [AGENTS.md](./AGENTS.md) and [llms.txt](./llms.txt) for the full agent brief, including how to request human approval and how resale / partner bundling is described (terms TBD). Tool contracts are in [docs/TOOLS.md](./docs/TOOLS.md). The catalog is [plans.json](./plans.json).

## Quickstart

**Once the npm package is published** (it is not published today):

```bash
XVCACHE_VAULT=/absolute/path/to/vault npx -y xvcache-mcp
```

Optional: `XVCACHE_LOG=/absolute/path/to/xvcache-journal.jsonl` (must stay **outside** the vault). If unset, the journal is created as `xvcache-journal.jsonl` next to the vault directory. `JAYCACHE_VAULT` and `JAYCACHE_LOG` remain accepted aliases.

**Local install**, from this folder, without publishing:

```bash
npm install
npm test
npm run build
XVCACHE_VAULT=/absolute/path/to/vault node dist/server.js
```

The vault must already exist. Only `.md` notes inside it are in scope.

## Configuration

Replace `/absolute/path/to/vault` with the vault directory. Until `xvcache-mcp` is on npm, point `command` at `node` and `args` at this repo's `dist/server.js`, or use the `npx` form after publication.

### Codex (`~/.codex/config.toml` or a project `.codex/config.toml`)

```toml
[mcp_servers.xvcache]
command = "npx"
args = ["-y", "xvcache-mcp"]
env = { XVCACHE_VAULT = "/absolute/path/to/vault" }
```

Local, unpublished build:

```toml
[mcp_servers.xvcache]
command = "node"
args = ["/absolute/path/to/xvcache-repo/dist/server.js"]
env = { XVCACHE_VAULT = "/absolute/path/to/vault" }
```

### Claude Desktop / Claude Code

Claude Desktop (`claude_desktop_config.json`; macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`, Linux: `~/.config/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "xvcache": {
      "command": "npx",
      "args": ["-y", "xvcache-mcp"],
      "env": { "XVCACHE_VAULT": "/absolute/path/to/vault" }
    }
  }
}
```

Claude Code can use the same JSON in a project `.mcp.json`, or:

```bash
claude mcp add --transport stdio xvcache --env XVCACHE_VAULT=/absolute/path/to/vault -- npx -y xvcache-mcp
```

See [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

### Cursor

Project file `.cursor/mcp.json`, or the user MCP config (see [Cursor MCP docs](https://cursor.com/docs/mcp)):

```json
{
  "mcpServers": {
    "xvcache": {
      "command": "npx",
      "args": ["-y", "xvcache-mcp"],
      "env": { "XVCACHE_VAULT": "/absolute/path/to/vault" }
    }
  }
}
```

### Generic MCP JSON

```json
{
  "mcpServers": {
    "xvcache": {
      "command": "npx",
      "args": ["-y", "xvcache-mcp"],
      "env": {
        "XVCACHE_VAULT": "/absolute/path/to/vault"
      }
    }
  }
}
```

For a local build, use `"command": "node"` and `"args": ["/absolute/path/to/xvcache-repo/dist/server.js"]`.

## Demo: verdict V, then verdict X

These steps assume the server is already attached to your agent and `XVCACHE_VAULT` points at a writable vault.

1. Ask the agent to create a note with `write_note` (mode `create`), for example `Tests/Demo.md`.
2. Ask it to call `verify_journal` with that path. You should see **V** and `intacte depuis`.
3. Change the file **outside** XVcache (a text editor, or `printf` appended to the file). Do not call `write_note` or `read_note` in between if you want a clean X.
4. Call `verify_journal` on the same path again. You should see **X** and `MODIFIÉE hors XVcache`.
5. Optional: call `verify_journal` with no path — the journal chain itself should still be intact. `certify_note` will tell you that independent witness certification is à venir.

## Tools

See [docs/TOOLS.md](./docs/TOOLS.md) for the full contract.

Available now: `read_note`, `search_notes`, `write_note`, `verify_journal`.

For agents that need to buy, certify, or resell, also: `get_offer`, `list_plans`, `recommend_plan`, `request_upgrade` (human-approval stub, no live payment), `certify_note` (stub, witness à venir).

## Journal format

Each line of the JSONL journal is one entry. The payload (the entry without `hash`) is serialized as canonical JSON (sorted keys, no extra spaces). Then:

```text
hash = sha256_hex(prev_hash + canonicalJson(payload))
```

The first entry uses a genesis `prev_hash` of 64 zero hex characters. Fields include `seq`, `ts`, `tool`, `args` (path, query, mode — never the note body), `client`, `result` (`ok` or `erreur`), `note_sha256`, `prev_hash`, and `hash`. `verify_journal` is not appended to the journal.

You can also check a file from the shell:

```bash
npm run verify-journal -- /path/to/xvcache-journal.jsonl
```

## Security notes

- The chain is **tamper-evident**, not tamper-proof. Someone who can rewrite the journal can build a new, internally consistent chain. The independent certifying witness is **à venir**.
- The journal must live outside the vault (`XVCACHE_LOG`).
- Absolute paths, `..` segments, and writes through symbolic links are rejected. Only `.md` files are in scope.
- This is not a qualified electronic timestamp and not legal advice. See [SECURITY.md](./SECURITY.md).

## Limits

- STDIO only: this server does not open a network port.
- `write_note` is capped at 256 KiB per call.
- Local V/X is not an independent certification.
- Prices and most bundle quotas in `plans.json` are placeholders marked **TBD**. Payment is not live.

## Independent witness (à venir)

A paid, independent witness that can horodate and sign verdicts (Ed25519 / qualified timestamp) is planned. It is not in this repository. `certify_note` exists so agents can already discover that path and tell their human it is à venir.

## License and trademark

Licensed under the [Apache License 2.0](./LICENSE). The license does not grant trademark rights. **XVcache** is a trademark filed in France, INPI no. 5323492, status *déposée* (filed), not presented here as registered. See [TRADEMARK.md](./TRADEMARK.md) and [NOTICE](./NOTICE).
