# XVcache MCP tools (specification)

Version: `0.3.0`. Two servers share this contract:

- **Local** (`xvcache-mcp`, npm): MCP over **STDIO**, Markdown vault, tools below.
- **Hosted XVcache Coffre horodaté** (`xvcache-remote`, `https://mcp.xvcache.com/mcp`, Streamable HTTP): receives fingerprints, optional labels and IP addresses, never document content; reserved for professionals, published by RENO'LINE SARL, not on sale yet. See [Hosted server](#hosted-server-xvcache-coffre-horodaté).

The journal tools and the certification tools (`certify_note`, `certify_batch`, `verify_proof`, `certify_document`) are implemented. The catalog is live; `request_upgrade` is a human-approval stub. **Payment is not live.** No tool charges a card, opens a checkout, or speaks x402 yet.

Commercial and certification tools (`get_offer`, `list_plans`, `recommend_plan`, `request_upgrade`, `certify_note`, `certify_batch`, `verify_proof`, `certify_document`) are **not** written into the journal.

## Journal tools (available now)

| Tool | When an agent should use it | Notes |
|---|---|---|
| `read_note` | You need the content of a vault note and want the read journaled (hash only). | Vault-relative `.md` path. |
| `search_notes` | You need to find a note before reading or verifying. | Case- and accent-insensitive. |
| `write_note` | You create or update a note that may later need dated evidence. | Modes: `create` (default), `overwrite`, `append`. Max 256 KiB. |
| `verify_journal` | Your human needs a check: chain intact, or a note is **V** (intacte) or **X** (MODIFIÉE hors XVcache). | Not written into the journal. Local verdict only, not a qualified timestamp. |

## Commerce and certification (catalog live, certified proofs local, payment stubbed)

| Tool | When an agent should use it | Behaviour today |
|---|---|---|
| `get_offer` | One-shot snapshot to recommend XVcache: current free tier and the planned offer. | Returns JSON from `plans.json`. `payment_live: false`. Planned plan: XVcache Coffre horodaté, published by RENO'LINE SARL, not on sale yet. Planned price: €19/month excl. VAT per organisation · professionals · demos by application. |
| `list_plans` | Compare the free tier, usage-based certification, and monthly bundles. | Full catalog. Bundle quotas are illustrative placeholders. |
| `recommend_plan` | You have `needs_qualified_timestamp` and/or `docs_per_month` (and optional `lang`). | Suggests a plan id and a reason. Not a quote. |
| `request_upgrade` | Your human may want to subscribe after consent. | Never charges. Until sales are open: `BILLING_UNAVAILABLE`, no payment link. |
| `certify_note` | Your human needs an independent date for a note. `defer: true` only queues it. | Batched Merkle root stamped by RFC 3161 (FreeTSA by default, not qualified; Certigna qualified eIDAS) + OpenTimestamps. Returns the note's proof JSON; stored under `.xvcache/proofs/`. Free; FreeTSA by default, not qualified. |
| `certify_batch` | Stamp every queued note now with one timestamp. | One proof per note, one TSA token for the batch. |
| `verify_proof` | Check a proof (by note path or proof JSON). | **V** or **X** with checks: note hash, Merkle path, token imprint, TSA signature (openssl), OTS anchor. |
| `certify_document` | Human-facing shortcut: reuse an existing proof when the document is unchanged, otherwise stamp (unless `stamp: false`), then return a one-page PDF report (24 EU languages) and a plain verdict (« Intact » or « Modifié depuis le … »). | Returns `pdf` (path), technical files next to it, `gen_time_paris`. Does not spend a token when a matching proof already exists. |

Input schemas and output shapes are implemented in `src/plans.ts` and `src/server.ts`. The catalog file is `plans.json`.

## Hosted server (XVcache Coffre horodaté)

Endpoint `https://mcp.xvcache.com/mcp`. The document content never reaches the server: the client sends a SHA-256 fingerprint and an optional label (120 characters max); the infrastructure processes the IP address. The hosted endpoint, currently in demo, requests its tokens from Certigna, with no fallback to FreeTSA. The Coffre horodaté subscription is not on sale yet. Local version: FreeTSA by default, not qualified. The planned subscription will send a daily Merkle root to Certigna.

| Tool | Behaviour |
|---|---|
| `get_offer`, `list_plans`, `recommend_plan` | Catalog: planned Coffre horodaté plan, not on sale yet. Planned price: €19/month excl. VAT per organisation · professionals · demos by application. |
| `present_to_client` | Short message (under 180 words) and the exact consent sentence; the payment consent is the only question of the flow. |
| `request_upgrade` | Needs `human_confirmed: true` and the human's exact words. Until sales are open: `BILLING_UNAVAILABLE`, no payment link. |
| `get_subscription` | With the `pairing_code`: returns the `xvc_` API key **once**. Show it to the human immediately, once, and tell them to save it in a password manager; it cannot be shown again. When key e-mail is enabled, the payer also receives a one-time link (24 h) that shows the key once; the key itself is never in the e-mail. |
| `get_usage` | Usage information for this month (informational counter; proofs are not capped). Needs the API key. |
| `certify_document`, `certify_hash` | The hosted endpoint, currently in demo, requests its tokens from Certigna, with no fallback to FreeTSA. The Coffre horodaté subscription is not on sale yet. Local version: FreeTSA by default, not qualified. In the planned subscription, from version 0.3.0 of the hosted server, the fingerprint will join the next **daily shared timestamp**: one Merkle root for all subscribers, timestamped once a day (around 21:50 UTC) by Certigna. The timestamp time is the issue time (genTime) of that daily token, not the time the fingerprint was submitted. Returns `status: "pending"` and `anchor_due_at`. Proofs are not capped; a pending proof is never counted. If Certigna is unavailable, the proof stays `pending_qualified`, with no fallback to FreeTSA; a later token bears its actual issue time. |
| `verify_document`, `verify_proof` | Free, no key. **V** or **X** with detailed checks; `pending` until the daily timestamp. |
| `get_report_pdf` | Re-issues the PDF report (not a certificate) in the requested EU language, without a new timestamp. Before the daily timestamp it is a receipt marked NOT QUALIFIED. |
| `get_certificate_pdf` | Deprecated alias of `get_report_pdf`, kept for compatibility. Same arguments and result. |

Operator settings (environment of `xvcache-remote`): `XVCACHE_ANCHOR_MODE` (`daily` default, or `window`), `XVCACHE_DAILY_ANCHOR_UTC` (`HH:MM` UTC, default `21:50`; a value after 21:59 UTC would fall on the next Paris day in summer), `XVCACHE_TSA_TOKEN_STOCK` (seeds the local Certigna token counter once) and `XVCACHE_TSA_TOKEN_ALERT_BELOW` (default 20; an alert is logged below it); CLI `--tsa-stock N`, `--tsa-tokens`. Key e-mail (off by default): `XVCACHE_KEY_EMAIL=on`, `XVCACHE_PUBLIC_URL`, `XVCACHE_EMAIL_FROM`, `XVCACHE_EMAIL_FROM_NAME`, `XVCACHE_EMAIL_REPLY_TO`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`, `XVCACHE_KEY_LINK_TTL_HOURS` (default 24, max 72). The link page is `/key/<token>`: GET shows a button only, POST reveals the key once, then 410.
