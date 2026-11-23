# Changelog

## 0.3.0 — 2026-11-23 (prepared, not published)

### Hosted XVcache Coffre horodaté
- **Daily shared anchor** (from 0.3.0 of the hosted server; planned subscription): one Merkle root for all subscribers, to be timestamped by Certigna once a day (default 21:50 UTC = 22:50 Paris in winter, 23:50 in summer, always the same Paris calendar day; `XVCACHE_ANCHOR_MODE`, `XVCACHE_DAILY_ANCHOR_UTC`). The timestamp time is the issue time of the daily token, not the submission time. The currently deployed hosted endpoint uses FreeTSA (not qualified). `certify_document` / `certify_hash` return `pending` with `anchor_due_at` until a token is issued. The former time-window batching stays available (`XVCACHE_ANCHOR_MODE=window`).
- **Proofs are not capped**: usage is an informational counter, counted only when a timestamp token is obtained; a `pending` or `pending_qualified` proof is never counted. The hosted tools no longer return `QUOTA_EXCEEDED`.
- **Qualification from the token only**: a proof is `qualified` only if its token carries the Certigna policy OID `1.2.250.1.177.2.9.1`, chains to Certigna and its signature verifies (from `fix/qualified-from-token`).
- **Certigna token counter**: local ledger of tokens used, seeded with `XVCACHE_TSA_TOKEN_STOCK` or `--tsa-stock N`; a log alert is raised below `XVCACHE_TSA_TOKEN_ALERT_BELOW` (default 20). `--tsa-tokens` prints the status.
- **API key by e-mail (off by default, `XVCACHE_KEY_EMAIL=on`)**: after `checkout.session.completed`, the payer's e-mail receives a one-time link (24 h by default) to `/key/<token>` on the MCP server, sent with Cloudflare Email Sending. The key is never in the e-mail; only a hash of the link token is stored and the key is kept encrypted until it is revealed once or expires. `GET` shows a button only (mail scanners do not consume the link); `POST` reveals the key once, then `410`.
- `get_subscription`: the AI shows the `xvc_` key immediately, once, and tells the human to save it in a password manager.

### Public texts (aligned on the internal legal review, 23 November 2026)
- Product name **XVcache Coffre horodaté**; reserved for professionals; **published by RENO'LINE SARL, not on sale yet**. Planned price: €19 excl. VAT / month per organisation · professionals · demos on application. No payment can be made at this stage. No trial; cancellation (once sales open) effective at the end of the paid month.
- Tool descriptions aligned on the legal review (E01–E16): `get_usage` is an informational counter; `get_offer` no longer says « sold »; inherited `reseller` / `needs_certified_witness` / `certifications_per_month` fields removed from the public schema; `request_upgrade` returns `BILLING_UNAVAILABLE` with no payment link until sales open (Stripe TEST links are not served in production); `certify_note` / `certify_batch` are free (FreeTSA by default, not qualified); `NOTICE` uses Sophie’s wording; site FAQ distinguishes local Markdown from hosted any-file fingerprints.
- `get_report_pdf` is the preferred tool to re-issue the PDF report (not a certificate). `get_certificate_pdf` is kept as a deprecated alias for compatibility.
- **Open point:** the on-disk / URL filename remains `certificat.pdf` (API names unchanged). A non-destructive proposal to also write `rapport.pdf` while still accepting `certificat.pdf` is in `PROPOSITION-NOM-RAPPORT.md`; it is not implemented in this release.
- "prove/proof" claims replaced by "dated evidence"; "PDF certificate" becomes "PDF report"; no "soon"/"bientôt".
- eIDAS cross-border recognition cited as art. 24a(6) (former art. 41(3) was deleted by Regulation (EU) 2024/1183); consolidated EUR-Lex link.
- Data disclosure: the hosted server receives the fingerprint, an optional label and the IP address; never "only the hash".
- README, llms.txt, llms-full.txt, AGENTS.md, docs/TOOLS.md, npm description, MCP Registry description, tool descriptions updated. README summaries in DE/ES/IT/NL/PL withdrawn until reviewed.
- Offer texts in the 22 languages other than English and French fall back to the English wording until a native review (`offer._note`).
- `present_to_client` message limit raised from 150 to 180 words to fit the mandatory legal wording.
- Slogan: *J'ai caché, j'ai daté.*

## 0.2.0 — 2026-11-22
- Published on npm and in the MCP Registry: local STDIO server, journal, V/X, batched RFC 3161 + OpenTimestamps, one-page PDF.
