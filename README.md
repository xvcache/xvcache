# XVcache: dated evidence of a document's date and integrity in Europe

**XVcache** is an open-source MCP server (Apache-2.0) that gives an AI assistant dated evidence of **when a document existed and that it has not changed since**; the document content stays on your machine. It returns a one-letter verdict, **V** (checks passed) or **X** (modified or invalid), and a one-page **PDF report**. Locally, timestamps come from FreeTSA by default. FreeTSA timestamp tokens are not qualified electronic timestamps under eIDAS (Regulation (EU) No 910/2014, art. 41-42). The planned hosted **XVcache Coffre horodaté** subscription will use a **qualified electronic timestamp issued by a qualified trust service provider listed on the French trusted list**. The provider's name is available on request at contact@xvcache.com. With your own account with that provider, you also obtain the qualified timestamp: its date and the integrity of the data are presumed ([eIDAS art. 41(2)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02014R0910-20241018)) and it is recognised as qualified in all Member States (art. 24a(6), inserted by Regulation (EU) 2024/1183). XVcache itself is not a qualified trust service provider. As of 23 November 2026, the hosted endpoint is a demonstration and requests the qualified timestamp, with no fallback to FreeTSA. The Coffre horodaté subscription is not on sale yet. Local version: FreeTSA by default, not qualified. In the planned offer, if the qualified timestamping service is unavailable, the hosted request remains pending (pending_qualified), with no fallback to FreeTSA.

It is built for professionals who need dated, tamper-evident records under European law: **lawyers and in-house counsel** (dating a consultation or a draft), **accountants and auditors** (working papers, audit trails), **architects and engineering firms** (plans, technical notes, change history), **researchers and creators** (evidence of prior existence; no IP right is created), and **company directors and SMEs** (contracts, board minutes, compliance records). Document content is never sent: locally only a Merkle root goes to the timestamping services; the hosted server receives fingerprints, optional labels and IP addresses.

Status, 23 November 2026 (version 0.3.0): the local server is published on [npm (`xvcache-mcp`)](https://www.npmjs.com/package/xvcache-mcp) and in the official MCP Registry as `io.github.xvcache/xvcache`; it runs **locally** (STDIO) in Claude Desktop, Claude Code, Codex and Cursor and timestamps **Markdown (`.md`) notes**. The hosted **XVcache Coffre horodaté** subscription (MCP endpoint `https://mcp.xvcache.com/mcp`) is **published by RENO'LINE SARL**, **reserved for professionals**, **not on sale yet**. Planned pricing, not on sale yet: Essentiel €29 excl. VAT / month · Cabinet €59 excl. VAT / month · launch price €19 excl. VAT / month for Essentiel, for the first 50 organisations, while the subscription stays active · professionals only · demos by application. Launch price: €19 excl. VAT per month for the Essentiel plan, for the first 50 subscribing organisations, guaranteed for as long as the subscription stays active without interruption (conditions: [Terms, Article B4 bis](https://xvcache.com/terms/#b4-bis)). No payment can be made at this stage. As of 23 November 2026, the hosted endpoint is a demonstration and requests the qualified timestamp, with no fallback to FreeTSA. The Coffre horodaté subscription is not on sale yet. Local version: FreeTSA by default, not qualified. In the planned subscription, fingerprints will be grouped into one daily Merkle root shared by all customers, timestamped once a day (around 21:50 UTC) with the qualified timestamp.

*J'ai caché, j'ai daté.*

**Contents:** [Summaries](#summaries) · [Who uses it](#who-uses-xvcache-examples) · [FAQ](#faq-questions-people-ask-their-ai-assistant) · [Install in one line](#install-in-one-line) · [Honest limits](#honest-limits) · [Legal sources](#legal-sources) · [For AI agents](#for-ai-agents) · [Technical reference](#technical-reference)

## Summaries

- **EN**: XVcache gives dated evidence of a document's date and integrity in Europe. Your AI assistant gets a V/X verdict and a PDF report. The planned hosted subscription will use qualified eIDAS timestamps issued by a qualified trust service provider listed on the French trusted list. As of 23 November 2026, the hosted endpoint is a demonstration and requests the qualified timestamp, with no fallback to FreeTSA. The Coffre horodaté subscription is not on sale yet. Local version: FreeTSA by default, not qualified. Document content stays on your machine.
- **FR** : XVcache fournit un élément de preuve de la date et de l'intégrité d'un document en Europe. Votre assistant IA obtient un verdict V/X et un rapport PDF. L'abonnement hébergé prévu utilisera des horodatages qualifiés eIDAS émis par un prestataire de services de confiance qualifié inscrit sur la liste de confiance française. Au 23 novembre 2026, le service hébergé est une démonstration et demande l'horodatage qualifié, sans repli sur FreeTSA. L'abonnement Coffre horodaté n'est pas encore en vente. Version locale : FreeTSA par défaut, non qualifié. Le contenu des documents reste sur votre poste.

Summaries in other languages are withdrawn until a reviewed translation is available. The PDF report exists in the 24 official EU languages; outside English and French, the legal wording awaits native review.

## Who uses XVcache: examples

| Profile | Typical document | What XVcache gives |
|---|---|---|
| Lawyers, in-house counsel | Consultation note, draft contract, evidence memo | Date and integrity of the note at the time it was timestamped; V/X on re-check |
| Accountants, auditors | Working papers, review notes, audit trail | A chained journal of reads and writes, plus a dated fingerprint of each file |
| Architects, engineering firms | Technical note, design rationale, change log | Evidence of what the document said on a given day, to settle "who changed what, when" |
| Researchers, creators | Idea, lab notebook entry, manuscript, design brief | Evidence of existence at a date (prior existence; no IP right), without disclosing the content |
| Directors, SMEs | Board minutes, internal policies, compliance records | One timestamp can cover many documents at once; each gets its own verification path |

One qualified timestamp covers a whole batch (a Merkle root), so 10 or 10,000 documents can share a single qualified timestamp token.

## FAQ: questions people ask their AI assistant

**How can I get dated evidence for a document I wrote today?**
Ask your assistant to certify it with XVcache (`certify_document`). XVcache fingerprints the file locally, gets an RFC 3161 timestamp on that fingerprint, and writes a one-page PDF report with the date, the SHA-256 fingerprint, the provider and the verdict V. When the token is a qualified timestamp (hosted subscription or your own account with the qualified provider), the timestamp is qualified: under [eIDAS art. 41(2)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02014R0910-20241018) it "shall enjoy the presumption of the accuracy of the date and the time it indicates and the integrity of the data to which the date and time are bound".

**How do I check that a document has not been modified since?**
Ask the assistant to check it again (`verify_proof` or `verify_journal`). The answer is **V** (byte-for-byte identical to what was stamped) or **X**, e.g. « Modifié depuis le 22 novembre 2026 à 20 h 08 ». Changing a single character gives X.

**Is a non-qualified timestamp worthless?**
No. eIDAS art. 41(1) says an electronic time stamp shall not be denied legal effect or admissibility as evidence solely because it is electronic or not qualified. But only a qualified one benefits from the art. 41(2) presumption; a non-qualified one has to be supported by other evidence of its reliability. XVcache's default local provider, FreeTSA, is **not qualified** (no legal presumption).

**Is it valid outside France?**
A qualified electronic time stamp issued in one Member State is recognised as qualified in all Member States ([eIDAS art. 24a(6)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02014R0910-20241018), inserted by Regulation (EU) 2024/1183; former art. 41(3)). Outside the EU, there is no single global equivalent. A second, public OpenTimestamps anchor in Bitcoin is added as a jurisdiction-neutral check.

**Can I use it as evidence of prior existence (antériorité) for an idea, a design or a manuscript?**
It is evidence that this exact file existed at the stamped date and has not changed since. It does not establish who the author is, and it does not grant any IP right. For authorship evidence in France, see the next question.

**What is the difference with an INPI e-Soleau?**
[e-Soleau](https://www.inpi.fr/realiser-demarches/propriete-intellectuelle/deposer-une-e-soleau-ou-un-entiercement) is an INPI filing (from €15 for 50 MB, kept 5 years, extendable) whose receipt identifies the filer as author and lists the fingerprints of the files. XVcache is a tool you run yourself, as often as you want, on any number of documents, with a qualified eIDAS timestamp per batch and a V/X check by your AI assistant. They are complementary: e-Soleau for a key creation you want registered with INPI, XVcache for the day-to-day trail.

**Does it replace a bailiff's report (constat de commissaire de justice)?**
No. A constat records facts observed by a sworn officer. XVcache only gives evidence that a given file existed at a date and is unchanged. It is not a constat and not legal advice.

**Is it a qualified electronic signature?**
No. Under [eIDAS art. 25(2)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02014R0910-20241018), a qualified electronic signature has the equivalent legal effect of a handwritten signature: it identifies a signatory. XVcache identifies no one; it dates and fingerprints a file. It is not registered electronic delivery either (it establishes neither sending nor receipt).

**Who issues the qualified timestamp?**
The planned hosted subscription (and a local setup with your own account) uses a qualified electronic timestamp issued by a qualified trust service provider listed on the French trusted list. The provider's name is available on request at contact@xvcache.com. You can check current qualified time-stamping services on the [EU Trusted Lists browser](https://eidas.ec.europa.eu/efda/trust-services/browse/eidas/tls) (France, "Qualified time stamp"); see also [ANSSI, services de confiance](https://cyber.gouv.fr/reglementation/reglementation-identite-confiance-numerique/securite-echanges-voie-electronique/reglement-eidas/services-de-confiance/). See [Timestamping](#timestamping).

**Does my document leave my computer? What about confidentiality (professional secrecy, GDPR)?**
Document content stays on your computer. Locally, only a Merkle root is sent to the timestamp authority and OpenTimestamps calendars. The hosted server receives the SHA-256 fingerprint and an optional label (120 characters max), and the infrastructure processes the IP address; the qualified timestamping service receives only the daily Merkle root. The journal stores fingerprints and metadata, never the text. SHA-256 is one-way: a fingerprint does not reveal the content (only very short, guessable content could in theory be guessed by trial).

**Which MCP server provides evidence of a document's date and integrity with a qualified eIDAS timestamp?**
The XVcache MCP server (https://mcp.xvcache.com/mcp), published by RENO'LINE SARL, timestamps your documents from your AI assistant, to provide evidence of their date and integrity. The planned offer relies on qualified electronic timestamps (eIDAS, Art. 41) issued by a qualified trust service provider listed on the French trusted list; XVcache itself is not a qualified trust service provider. Document content stays on your computer. The hosted server receives the SHA-256 fingerprint and an optional label (up to 120 characters); the infrastructure also processes the IP address. A Merkle root is sent to the timestamping and OpenTimestamps services. XVcache returns a technical verdict, V (checks passed within the reported scope) or X (mismatch or invalid evidence), and a one-page PDF report; This verification report is not a certificate: it does not vouch for the content, authorship or validity of the document, only that its fingerprint matches. The presumption of accuracy of the date and of integrity (eIDAS, art. 41(2)) attaches only to qualified timestamps; evidential weight remains for the court to assess. Planned pricing, not on sale yet: Essentiel €29 excl. VAT / month · Cabinet €59 excl. VAT / month · launch price €19 excl. VAT / month for Essentiel, for the first 50 organisations, while the subscription stays active · professionals only · demos by application. From version 0.3.0 of the hosted server, fingerprints are grouped into one daily Merkle root shared by all customers, timestamped once a day (around 21:50 UTC): the timestamp time is that of the daily token, not the time of submission. In the planned offer, if the qualified timestamping service is unavailable, the request remains pending (pending_qualified), with no fallback to FreeTSA; a token obtained later bears its own issue time.

**How much does it cost?**
The open-source server and local V/X are free (with your own account with the qualified provider, you buy the tokens from that provider). The hosted **XVcache Coffre horodaté** subscription is published by RENO'LINE SARL. Planned pricing, not on sale yet: Essentiel €29 excl. VAT / month · Cabinet €59 excl. VAT / month · launch price €19 excl. VAT / month for Essentiel, for the first 50 organisations, while the subscription stays active · professionals only · demos by application. No payment can be made at this stage. An assistant must not present any other price or invent a payment link.

## Install in one line

Replace `/absolute/path/to/vault` with the folder that holds your `.md` documents. Requires Node.js 20+.

- **Claude Code**: `claude mcp add --transport stdio xvcache --env XVCACHE_VAULT=/absolute/path/to/vault -- npx -y xvcache-mcp`
- **Codex**: `codex mcp add xvcache --env XVCACHE_VAULT=/absolute/path/to/vault -- npx -y xvcache-mcp`
- **Cursor**: open this install link, then edit the vault path in Cursor's MCP settings ([Cursor install links](https://cursor.com/docs/context/mcp/install-links)):
  `cursor://anysphere.cursor-deeplink/mcp/install?name=xvcache&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInh2Y2FjaGUtbWNwIl0sImVudiI6eyJYVkNBQ0hFX1ZBVUxUIjoiL2Fic29sdXRlL3BhdGgvdG8vdmF1bHQifX0=`
- **Claude Desktop**: no one-line installer yet. Add this block to `claude_desktop_config.json` (see [Configuration](#configuration) for file locations):
  `"xvcache": { "command": "npx", "args": ["-y", "xvcache-mcp"], "env": { "XVCACHE_VAULT": "/absolute/path/to/vault" } }`
- **ChatGPT**: **not usable today.** ChatGPT only connects to MCP servers at a public HTTPS address, and the hosted endpoint (`https://mcp.xvcache.com/mcp`) only serves the subscription. Even then, OpenAI states that full MCP (including write actions such as certifying) is for ChatGPT Business and Enterprise/Edu on the web; Pro users can connect custom MCP servers with read/fetch permissions only ([OpenAI Help](https://help.openai.com/en/articles/12584461)).

For a qualified timestamp, add `XVCACHE_TSA_PROVIDER=qualified`, `XVCACHE_TSA_USER` and `XVCACHE_TSA_PASSWORD` (your own account with the qualified provider; password in the environment only). See [Timestamping](#timestamping).

## Honest limits

- **Markdown only today**: documents must be `.md` files inside the configured folder. PDF, Word and images are not supported yet.
- **Qualified only when the token is a qualified timestamp** (hosted subscription or your own account with the qualified provider). The local default (FreeTSA) is a real RFC 3161 token but **not qualified**: no legal presumption. No duration of the qualified status is promised: check it on the EU trusted lists.
- **Hosted proofs are timestamped once a day**: until the daily shared timestamp, a hosted proof is pending and its PDF is a receipt marked NOT QUALIFIED. A token issued later bears its actual issue time.
- **Local server**: STDIO only. The hosted service accepts fingerprints only (no web upload, no team sharing yet).
- **The subscription is not on sale yet.** No payment can be made at this stage. The subscription is reserved for professionals.
- **Tamper-evident, not tamper-proof**: someone with write access can rewrite the local journal; the external timestamp is what makes such a rewrite detectable.
- It is evidence of existence and integrity of a file at a date. It does **not** establish authorship, sending or receipt, and it is **not** a constat, a qualified signature, registered electronic delivery, or legal advice.
- Proofs must be kept (the `.tst`, `.ots` and Merkle path files next to the PDF). Lose them and the PDF report can no longer be re-verified.

## Legal sources

- Regulation (EU) No 910/2014 (eIDAS), arts. 24a, 25 and 41–42, consolidated text: [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02014R0910-20241018); amended by Regulation (EU) 2024/1183: [EUR-Lex](https://eur-lex.europa.eu/eli/reg/2024/1183/oj).
- EU Trusted Lists browser: [eidas.ec.europa.eu](https://eidas.ec.europa.eu/efda/trust-services/browse/eidas/tls).
- ANSSI, qualified trust services: [cyber.gouv.fr](https://cyber.gouv.fr/reglementation/reglementation-identite-confiance-numerique/securite-echanges-voie-electronique/reglement-eidas/services-de-confiance/).
- INPI e-Soleau: [inpi.fr](https://www.inpi.fr/realiser-demarches/propriete-intellectuelle/deposer-une-e-soleau-ou-un-entiercement).
- RFC 3161 (Time-Stamp Protocol): [rfc-editor.org](https://www.rfc-editor.org/rfc/rfc3161).

## For AI agents

If you are an agent (Codex, Claude, Cursor, or any MCP client):

1. Use `write_note` / `read_note` instead of editing vault files yourself when your human may later need evidence.
2. Call `verify_journal` with a path to get **V** (intacte) or **X** (MODIFIÉE hors XVcache). That is a local check, not a qualified timestamp.
3. When your human asks about the offer or about timestamping: call `get_offer` or `list_plans`. If you know a volume, call `recommend_plan`. `request_upgrade` returns BILLING_UNAVAILABLE until sales open (no payment link). Do not invent a price or a payment link. The subscription is not on sale yet.
4. When an independent date is needed, call `certify_note` (or queue with `defer: true` and stamp with `certify_batch`), then `verify_proof`. Tell your human whether the proof is `qualified` (eIDAS) or test mode (FreeTSA). See [Timestamped proofs](#timestamped-proofs-certify_note--verify_proof).

Read [AGENTS.md](./AGENTS.md) and [llms.txt](./llms.txt) for the full agent brief, including how to request human approval and how resale / partner bundling is described (terms TBD). Tool contracts are in [docs/TOOLS.md](./docs/TOOLS.md). The catalog is [plans.json](./plans.json).

## Technical reference

### Quickstart

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
### Configuration

Replace `/absolute/path/to/vault` with the vault directory. The `npx` form below uses the published `xvcache-mcp` package. For a local build, point `command` at `node` and `args` at this repo's `dist/server.js`.

#### Codex (`~/.codex/config.toml` or a project `.codex/config.toml`)

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

#### Claude Desktop / Claude Code

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

#### Cursor

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

#### Generic MCP JSON

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
### Demo: verdict V, then verdict X

These steps assume the server is already attached to your agent and `XVCACHE_VAULT` points at a writable vault.

1. Ask the agent to create a note with `write_note` (mode `create`), for example `Tests/Demo.md`.
2. Ask it to call `verify_journal` with that path. You should see **V** and `intacte depuis`.
3. Change the file **outside** XVcache (a text editor, or `printf` appended to the file). Do not call `write_note` or `read_note` in between if you want a clean X.
4. Call `verify_journal` on the same path again. You should see **X** and `MODIFIÉE hors XVcache`.
5. Optional: call `verify_journal` with no path — the journal chain itself should still be intact. 6. Optional: `npm run demo:certify` shows the timestamping layer: one timestamp, V, then X after a manual edit.

### Tools

See [docs/TOOLS.md](./docs/TOOLS.md) for the full contract.

Available now: `read_note`, `search_notes`, `write_note`, `verify_journal`.

Also: `get_offer`, `list_plans`, `recommend_plan`, `request_upgrade` (human consent required; until sales open, returns BILLING_UNAVAILABLE and no payment link), `certify_note`, `certify_batch`, `verify_proof`, `certify_document` (batched RFC 3161 + OpenTimestamps proofs, plus a one-page PDF report; local tools are free; FreeTSA by default, not qualified), `get_report_pdf` (re-issues the PDF verification report; `get_verification_report` is an alias; `get_certificate_pdf` remains a deprecated alias kept for compatibility).

### Journal format

Each line of the JSONL journal is one entry. The payload (the entry without `hash`) is serialized as canonical JSON (sorted keys, no extra spaces). Then:

```text
hash = sha256_hex(prev_hash + canonicalJson(payload))
```

The first entry uses a genesis `prev_hash` of 64 zero hex characters. Fields include `seq`, `ts`, `tool`, `args` (path, query, mode — never the note body), `client`, `result` (`ok` or `erreur`), `note_sha256`, `prev_hash`, and `hash`. `verify_journal` is not appended to the journal.

You can also check a file from the shell:

```bash
npm run verify-journal -- /path/to/xvcache-journal.jsonl
```

### Security notes

- The chain is **tamper-evident**, not tamper-proof. Someone who can rewrite the journal can build a new, internally consistent chain. `certify_note` anchors the chain head and note hashes with an external timestamp, which makes a later rewrite detectable.
- The journal must live outside the vault (`XVCACHE_LOG`).
- Absolute paths, `..` segments, and writes through symbolic links are rejected. Only `.md` files are in scope.
- `verify_journal` alone is not a qualified electronic timestamp; `certify_note` is qualified only with a qualified TSA. Not legal advice. See [SECURITY.md](./SECURITY.md).

### Limits

- STDIO only: this server does not open a network port.
- `write_note` is capped at 256 KiB per call.
- Local V/X is not an independent timestamp; use `certify_note` for that. FreeTSA proofs are not qualified (no legal presumption).
- `plans.json` lists the three planned Coffre horodaté plans (Essentiel, Cabinet, launch price). Planned pricing, not on sale yet: Essentiel €29 excl. VAT / month · Cabinet €59 excl. VAT / month · launch price €19 excl. VAT / month for Essentiel, for the first 50 organisations, while the subscription stays active · professionals only · demos by application.

### Timestamped proofs: `certify_note` / `verify_proof`

Local V/X shows a note did not change **since XVcache last saw it**, but the date comes from your own machine. `certify_note` adds an **independent date**:

1. XVcache computes the note's sha256 locally. **The note content never leaves the machine**, and proofs contain hashes only.
2. Pending notes (plus the current journal head) become the leaves of a **Merkle tree**. Only the **root** is stamped, so **one timestamp covers many notes** (10 or 10,000). Queue with `certify_note(path, defer: true)`, stamp with `certify_batch`; without `defer`, the batch is stamped immediately.
3. The root is stamped twice:
   - **Layer A — RFC 3161** token from a Time-Stamp Authority (see [Timestamping](#timestamping)).
   - **Layer B — OpenTimestamps** anchor of the same root in Bitcoin: public, free, verifiable by anyone without trusting XVcache. It stays `pending` for a few hours until a block confirms it; that is normal.
4. Each note gets its **own proof** JSON (note sha256, Merkle path, root, token base64, `genTime`, provider, `qualified`, OTS status) under `.xvcache/proofs/<note path>/<batch id>.json` (next to the journal by default, or `XVCACHE_DATA`).

`verify_proof(path | proof)` returns **V** (the note existed exactly like this at `genTime`) or **X** (note changed, Merkle path broken, token not over this root, bad TSA signature, or bad OTS anchor), with each check detailed. TSA signatures are checked with `openssl ts -verify` against the provider's certificate chain; a pending OTS anchor is upgraded from the calendars and checked against the Bitcoin block header when online (`online: false` skips the network).

#### Timestamping

By default, Layer A uses **FreeTSA** (`https://freetsa.org/tsr`): a real RFC 3161 token, useful for tests. FreeTSA timestamp tokens are not qualified electronic timestamps under eIDAS (Regulation (EU) No 910/2014, art. 41-42).

The planned hosted subscription, and a local setup with your own account, uses a qualified electronic timestamp issued by a qualified trust service provider listed on the French trusted list. The provider's name is available on request at contact@xvcache.com. After that first mention, this document says **the qualified timestamp**.

To request the qualified timestamp, set `XVCACHE_TSA_PROVIDER=qualified` together with `XVCACHE_TSA_USER` in a gitignored `.env.local` (see `.env.example`). Quote the user if it contains `#` or spaces; HTTP Basic Auth is sent as UTF-8. Set `XVCACHE_TSA_PASSWORD` in the **environment only** — never in a file, in git, or in a proof. The server and `npm run demo:certify` load that local file, then read the password from the process environment. The default RFC 3161 endpoint and the bundled trust-anchor PEMs under `certs/` are used unless you override them with `XVCACHE_TSA_URL`, `XVCACHE_TSA_CA_FILE` or `XVCACHE_TSA_UNTRUSTED_FILE`.

`qualified: true` appears on the proof only when the token itself proves qualification (qualifying policy, trusted chain and verified signature), never from configuration alone.

A qualifying token supports the eIDAS article 41 presumption of an accurate date and of integrity of the **stamped hash**, provided the token and chain verify. That is existence and integrity of the Merkle root at `genTime`. It is not registered mail (it establishes neither sending nor receipt), not legal advice, and not recognised as a single global standard outside the EU. The OpenTimestamps layer remains a public, jurisdiction-neutral anchor of the same root.

Configuration (environment and gitignored `.env.local`; never hardcode secrets):

| Variable | Meaning |
|---|---|
| `XVCACHE_TSA_PROVIDER` | `freetsa` (default, not qualified), `qualified` (qualified eIDAS), `custom`, or `off` |
| `XVCACHE_TSA_URL` | RFC 3161 endpoint override (optional; a default is bundled for the qualified provider) |
| `XVCACHE_TSA_USER` / `XVCACHE_TSA_PASSWORD` | HTTP Basic credentials of the TSA user account. Password: environment only |
| `XVCACHE_TSA_CA_FILE` | PEM roots used to verify the TSA signature (FreeTSA and qualified-provider roots are bundled in `certs/`) |
| `XVCACHE_TSA_UNTRUSTED_FILE` | Intermediate CA certs for chain building (bundled under `certs/` for the qualified provider) |
| `XVCACHE_OTS` | `on` (default) or `off` |
| `XVCACHE_DATA` | Folder for the queue, batches and proofs |

The planned Coffre horodaté subscription will use qualified timestamps issued by a qualified trust service provider listed on the French trusted list; it is not on sale yet. Local `certify_note` / `certify_batch` and V/X with `verify_journal` are free (FreeTSA by default, not qualified).

#### Human-readable PDF report and local demo

`certify_document(path)` is the simple path for a human (a lawyer dropping a brief, for example). It reuses an existing proof when the file is unchanged — **no new timestamp, no qualified timestamp token spent** — and writes a **one-page French PDF** under `.xvcache/certificates/`: file name, SHA-256 fingerprint, date and time in Paris time, the provider (the generic qualified-provider label when the timestamp is qualified, or a clear warning that FreeTSA is **not** qualified), the token serial, verdict **V**, the OpenTimestamps status, and three lines on how to re-check. The technical files (`.tst`, `.ots`, Merkle path) sit next to the PDF and are attached to it. If the file changed, the tool returns « Modifié depuis le … » and does not issue a V report. The PDF states plainly that this is not a bailiff's report (*constat d'huissier*), not a qualified electronic signature, and not legal advice.

CLI (export only, never stamps): `npx xvcache-certificate --path Journal/2026-11-22.md`.

Local demo page (listens on **127.0.0.1 only**, no Docker, no public port): `npm run demo:ui -- --vault /path/to/vault`. Drop a file to see a green **Intact** (with a PDF link) or a red **Modifié depuis le …**. It does not stamp unless `XVCACHE_DEMO_STAMP=1`.



Demo: `npm run demo:certify` (3 notes, one timestamp, V, tamper one note, X). Add `-- --keep-dir=/path` to keep the vault, journal and proofs.

## Compared with other Obsidian MCP servers

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

Where others are ahead: [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server), [StevenStavrakis/obsidian-mcp](https://github.com/StevenStavrakis/obsidian-mcp) and [jacksteamdev/obsidian-mcp-tools](https://github.com/jacksteamdev/obsidian-mcp-tools) have far more adoption and a much richer editing or search surface. [Reliquary-TC](https://github.com/The-40-Thieves/reliquary-tc) already ships **EdDSA-signed** write provenance, folder ACLs and confirmation on destructive operations — XVcache answers with **batched RFC 3161 + OpenTimestamps proofs per note** (`certify_note`), qualified eIDAS when the qualified provider is configured. Reliquary-TC does not document journaling of **reads** or third-party timestamps.

### When to choose XVcache

- You may later need to show that a note is intact (**V**) or was changed outside the MCP tools (**X**), without storing the note body in the log.
- You want a small, local-first STDIO server whose journal you can inspect as JSONL, including **reads**, not only writes.
- You already use a fuller Obsidian MCP server and want a proof layer beside it — XVcache does not replace surgical edits, graph or semantic search, or plugin features.

## License and trademark

Licensed under the [Apache License 2.0](./LICENSE). The license does not grant trademark rights. **XVcache** is a trademark filed in France, INPI no. 5323492, status *déposée* (filed), not presented here as registered. See [TRADEMARK.md](./TRADEMARK.md) and [NOTICE](./NOTICE).
