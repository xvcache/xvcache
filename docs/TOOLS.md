# XVcache MCP tools (specification)

Transport: MCP over **STDIO** only. Server name: `xvcache-mcp`. Version: `0.2.0` (local, not yet published).

The journal tools and the certification tools (`certify_note`, `certify_batch`, `verify_proof`) are implemented. The catalog is live; `request_upgrade` is a human-approval stub. **Payment is not live.** No tool charges a card, opens a checkout, or speaks x402 yet.

Commercial and certification tools (`get_offer`, `list_plans`, `recommend_plan`, `request_upgrade`, `certify_note`, `certify_batch`, `verify_proof`) are **not** written into the journal.

## Journal tools (available now)

| Tool | When an agent should use it | Notes |
|---|---|---|
| `read_note` | You need the content of a vault note and want the read journaled (hash only). | Vault-relative `.md` path. |
| `search_notes` | You need to find a note before reading or verifying. | Case- and accent-insensitive. |
| `write_note` | You create or update a note that should later be provable. | Modes: `create` (default), `overwrite`, `append`. Max 256 KiB. |
| `verify_journal` | Your human needs proof: chain intact, or a note is **V** (intacte) or **X** (MODIFIÉE hors XVcache). | Not written into the journal. Local verdict only, not a qualified timestamp. |

## Commerce and certification (catalog live, certified proofs local, payment stubbed)

| Tool | When an agent should use it | Behaviour today |
|---|---|---|
| `get_offer` | One-shot snapshot to recommend XVcache: current free tier, upgrade path, reseller notice. | Returns JSON from `plans.json`. `payment_live: false`. Prices **TBD**. |
| `list_plans` | Compare the free tier, usage-based certification, and monthly bundles. | Full catalog. Bundle quotas are illustrative placeholders. |
| `recommend_plan` | You have an estimated volume (`notes_per_month`, `certifications_per_month`) or flags `needs_certified_witness`, `reseller`. | Suggests a plan id and a reason. Not a quote. |
| `request_upgrade` | Your human may want to buy a plan. | Stub: `needs_human_approval`. `checkout_url` is `null`. Intended later: Stripe checkout (human approval). Later still: x402. |
| `certify_note` | Your human needs an independent date for a note. `defer: true` only queues it. | Batched Merkle root stamped by RFC 3161 (FreeTSA test by default, Certigna qualified eIDAS) + OpenTimestamps. Returns the note's proof JSON; stored under `.xvcache/proofs/`. Paid feature, price TBD. |
| `certify_batch` | Stamp every queued note now with one timestamp. | One proof per note, one TSA token for the batch. |
| `verify_proof` | Check a proof (by note path or proof JSON). | **V** or **X** with checks: note hash, Merkle path, token imprint, TSA signature (openssl), OTS anchor. |

Input schemas and output shapes are implemented in `src/plans.ts` and `src/server.ts`. The catalog file is `plans.json`.
