# XVcache

**J'ai caché, j'ai prouvé.**

XVcache is a local MCP server that journals every read and write in a Markdown vault as a sha256-chained JSONL log, so you can later prove a note is intact (**V**) or was changed outside XVcache (**X**), without putting the note's content into the journal. It talks MCP over STDIO. The intended first user is an AI agent, which can also look up plans, suggest a bundle, and ask its human to approve a paid upgrade when billing exists.

Published source: [github.com/xvcache/xvcache](https://github.com/xvcache/xvcache) (Apache-2.0). npm: [`xvcache-mcp`](https://www.npmjs.com/package/xvcache-mcp) (0.1.0 published; 0.2.0 with certified proofs in this repo). Official MCP Registry: `io.github.xvcache/xvcache`. Site: [xvcache.com](https://xvcache.com). Payment is not live.

## Why XVcache (vs other Obsidian MCP servers)

Most Obsidian MCP servers help an agent **read and write** a vault. XVcache does that too, but its job is narrower: leave a **tamper-evident proof** that a note is still intact (**V**) or was changed outside these tools (**X**), without putting the note body in the log. It can run **alongside** a fuller Obsidian MCP server: use the other server for rich editing or search, and use XVcache when a later proof may be needed (prefer `write_note` / `read_note` for those notes).

Star counts and registry entries below were checked on 22 November 2026 (GitHub API; official MCP Registry).

| Server | Read/write notes | Tamper detection on a note | Chained audit / provenance journal | Content kept out of the log |
|---|---|---|---|---|
| **XVcache** | Yes (`read_note`, `search_notes`, `write_note`) | Yes: `verify_journal` compares the file on disk to the last fingerprint and returns **V** or **X** | Yes: sha256-chained JSONL of **reads and writes** | Yes (fingerprints and metadata only) |
| [obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) (716 stars; registry `io.github.cyanheads/obsidian-mcp-server`) | Yes — 14 tools, surgical edits, tags, frontmatter (via Local REST API) | Not documented | Not documented | n/a (no such journal documented) |
| [obsidian-mcp](https://github.com/StevenStavrakis/obsidian-mcp) (752 stars) | Yes — local filesystem, Obsidian app not required | Conflict/recovery if a note changed since a transaction; not a V/X proof of outside edits | Transaction snapshots for atomic writes and rollback (`.obsidian-mcp/transactions`), not a hash chain | No: recovery snapshots store note bytes |
| [obsidian-mcp-tools](https://github.com/jacksteamdev/obsidian-mcp-tools) (831 stars; **archived**) | Yes, as an Obsidian plugin + local MCP server (semantic search, templates) | Not for notes. SLSA provenance in the README applies to **downloaded binaries**, not vault files | Not documented | n/a |
| [obsidian-mcp-secure](https://github.com/dewtech-technologies/obsidian-mcp-secure) (registry `io.github.dewtech-technologies/obsidian-mcp-secure`) | Yes (via Local REST API) | Not documented | Rotating winston audit log (5 MB / 10 files), not described as hash-chained | No: the README states previous content goes to the audit log |
| [Reliquary-TC](https://github.com/The-40-Thieves/reliquary-tc) (13 stars; formerly `obsidian-tc`; that registry entry is deprecated after the rename) | Yes — large governed surface (ACLs, human-in-the-loop, search) | `provenance verify` checks the **record chain** (signatures, links). `get_provenance` returns write history with before/after sha256. Those documented tools do not return a one-letter current-file **V**/**X** | Yes, for **writes**: signed, hash-chained provenance in `cache.db` | Yes: hashes and attribution only, never note content |

Where others are ahead: [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server), [StevenStavrakis/obsidian-mcp](https://github.com/StevenStavrakis/obsidian-mcp) and [jacksteamdev/obsidian-mcp-tools](https://github.com/jacksteamdev/obsidian-mcp-tools) have far more adoption and a much richer editing or search surface. [Reliquary-TC](https://github.com/The-40-Thieves/reliquary-tc) already ships **EdDSA-signed** write provenance, folder ACLs and confirmation on destructive operations — XVcache answers with **batched RFC 3161 + OpenTimestamps proofs per note** (`certify_note`), qualified eIDAS when Certigna is configured. Reliquary-TC does not document journaling of **reads** or third-party timestamps.

### When to choose XVcache

- You may later need to show that a note is intact (**V**) or was changed outside the MCP tools (**X**), without storing the note body in the log.
- You want a small, local-first STDIO server whose journal you can inspect as JSONL, including **reads**, not only writes.
- You already use a fuller Obsidian MCP server and want a proof layer beside it — XVcache does not replace surgical edits, graph or semantic search, or plugin features.


## Français

**J'ai caché, j'ai prouvé.**

XVcache est un serveur MCP local (transport STDIO) qui journalise les lectures et écritures d'un coffre Markdown dans un journal JSONL chaîné par sha256. L'outil `verify_journal` rend le verdict **V** (intacte) ou **X** (MODIFIÉE hors XVcache), sans exposer le contenu de la note dans le journal. Le client visé en premier est un agent IA : il peut lister les offres, recommander un forfait, et demander l'accord d'un humain pour un passage à l'offre payante — quand la facturation existera.

La preuve certifiée (`certify_note` / `verify_proof`) horodate un lot de notes avec un seul tampon : jeton RFC 3161 (FreeTSA par défaut = test, non qualifié ; qualifié eIDAS avec Certigna) et ancrage OpenTimestamps dans Bitcoin, avec une preuve individuelle par note. C'est la fonction payante (prix TBD) ; le V/X local reste gratuit. Les prix du catalogue sont des **placeholders clairement marqués TBD**. Aucun paiement n'est en service. Dépôt public : [github.com/xvcache/xvcache](https://github.com/xvcache/xvcache). Comparaison avec d'autres serveurs MCP Obsidian : [Why XVcache](#why-xvcache-vs-other-obsidian-mcp-servers).

## For AI agents

If you are an agent (Codex, Claude, Cursor, or any MCP client):

1. Use `write_note` / `read_note` instead of editing vault files yourself when your human may later need a proof.
2. Call `verify_journal` with a path to get **V** (intacte) or **X** (MODIFIÉE hors XVcache). That is a local check, not a qualified timestamp.
3. When your human asks about buying, certifying, or reselling: call `get_offer` or `list_plans`. If you know a volume, call `recommend_plan`. To start a purchase, call `request_upgrade` and **show the result to your human**. Do not invent a price or a payment link. Payment is not live.
4. When an independent date is needed, call `certify_note` (or queue with `defer: true` and stamp with `certify_batch`), then `verify_proof`. Tell your human whether the proof is `qualified` (eIDAS, Certigna) or test mode (FreeTSA). See [Certified proofs](#certified-proofs-certify_note--verify_proof).

Read [AGENTS.md](./AGENTS.md) and [llms.txt](./llms.txt) for the full agent brief, including how to request human approval and how resale / partner bundling is described (terms TBD). Tool contracts are in [docs/TOOLS.md](./docs/TOOLS.md). The catalog is [plans.json](./plans.json).

## Quickstart

From npm:

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

Replace `/absolute/path/to/vault` with the vault directory. The `npx` form below uses the published `xvcache-mcp` package. For a local build, point `command` at `node` and `args` at this repo's `dist/server.js`.

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
5. Optional: call `verify_journal` with no path — the journal chain itself should still be intact. 6. Optional: `npm run demo:certify` shows the certified layer: one timestamp, V, then X after a manual edit.

## Tools

See [docs/TOOLS.md](./docs/TOOLS.md) for the full contract.

Available now: `read_note`, `search_notes`, `write_note`, `verify_journal`.

For agents that need to buy, certify, or resell, also: `get_offer`, `list_plans`, `recommend_plan`, `request_upgrade` (human-approval stub, no live payment), `certify_note`, `certify_batch`, `verify_proof` (batched RFC 3161 + OpenTimestamps proofs; paid feature, price TBD).

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

- The chain is **tamper-evident**, not tamper-proof. Someone who can rewrite the journal can build a new, internally consistent chain. `certify_note` anchors the chain head and note hashes with an external timestamp, which makes a later rewrite detectable.
- The journal must live outside the vault (`XVCACHE_LOG`).
- Absolute paths, `..` segments, and writes through symbolic links are rejected. Only `.md` files are in scope.
- `verify_journal` alone is not a qualified electronic timestamp; `certify_note` is qualified only with a qualified TSA (Certigna). Not legal advice. See [SECURITY.md](./SECURITY.md).

## Limits

- STDIO only: this server does not open a network port.
- `write_note` is capped at 256 KiB per call.
- Local V/X is not an independent certification; use `certify_note` for that. FreeTSA proofs are test-only.
- Prices and most bundle quotas in `plans.json` are placeholders marked **TBD**. Payment is not live.

## Certified proofs: `certify_note` / `verify_proof`

Local V/X proves a note did not change **since XVcache last saw it**, but the date comes from your own machine. `certify_note` adds an **independent date**:

1. XVcache computes the note's sha256 locally. **The note content never leaves the machine**, and proofs contain hashes only.
2. Pending notes (plus the current journal head) become the leaves of a **Merkle tree**. Only the **root** is stamped, so **one timestamp covers many notes** (10 or 10,000). Queue with `certify_note(path, defer: true)`, stamp with `certify_batch`; without `defer`, the batch is stamped immediately.
3. The root is stamped twice:
   - **Layer A — RFC 3161** token from a Time-Stamp Authority. Default: **FreeTSA = test, non qualifié** (no legal presumption). With a qualified provider (**Certigna**, eIDAS qualified trust service), the token carries the eIDAS presumption of accurate date and integrity (art. 41) across the EU. `qualified: true` only appears when Certigna is configured.
   - **Layer B — OpenTimestamps** anchor of the same root in Bitcoin: public, free, verifiable by anyone without trusting XVcache. It stays `pending` for a few hours until a block confirms it; that is normal.
4. Each note gets its **own proof** JSON (note sha256, Merkle path, root, token base64, `genTime`, provider, `qualified`, OTS status) under `.xvcache/proofs/<note path>/<batch id>.json` (next to the journal by default, or `XVCACHE_DATA`).

`verify_proof(path | proof)` returns **V** (the note existed exactly like this at `genTime`) or **X** (note changed, Merkle path broken, token not over this root, bad TSA signature, or bad OTS anchor), with each check detailed. TSA signatures are checked with `openssl ts -verify` against the provider's root certificate; a pending OTS anchor is upgraded from the calendars and checked against the Bitcoin block header when online (`online: false` skips the network).

Configuration (environment only, never hardcode secrets):

| Variable | Meaning |
|---|---|
| `XVCACHE_TSA_PROVIDER` | `freetsa` (default, test, non qualifié), `certigna` (qualified eIDAS), `custom`, or `off` |
| `XVCACHE_TSA_URL` | RFC 3161 endpoint override (Certigna default: `https://timestamp.dhimyotis.com/api/v1/`) |
| `XVCACHE_TSA_USER` / `XVCACHE_TSA_PASSWORD` | HTTP Basic credentials of the TSA user account (Certigna "compte utilisateur Horodatage") |
| `XVCACHE_TSA_CA_FILE` | PEM roots used to verify the TSA signature (FreeTSA and Certigna roots are bundled in `certs/`) |
| `XVCACHE_TSA_UNTRUSTED_FILE` | Intermediate CA certs for chain building (Certigna intermediates are bundled in `certs/certigna-untrusted.pem`) |
| `XVCACHE_OTS` | `on` (default) or `off` |
| `XVCACHE_DATA` | Folder for the queue, batches and proofs |

Certified proofs are the **paid feature** (price TBD, payment not live); local V/X with `verify_journal` stays free. A qualified timestamp proves **existence and integrity at a date**; it is not registered mail (it does not prove sending or receipt) and not legal advice. Outside the EU no single timestamp is recognised everywhere; the OpenTimestamps layer gives a public, jurisdiction-neutral anchor of the same root.

Demo: `npm run demo:certify` (temp vault, 3 notes, one timestamp, V, tamper one note, X).

## License and trademark

Licensed under the [Apache License 2.0](./LICENSE). The license does not grant trademark rights. **XVcache** is a trademark filed in France, INPI no. 5323492, status *déposée* (filed), not presented here as registered. See [TRADEMARK.md](./TRADEMARK.md) and [NOTICE](./NOTICE).
