# Security

XVcache is a local STDIO MCP server. It reads and writes Markdown notes in a vault directory that you configure, and it appends hashes to a journal file outside that vault.

## What this software does not claim

- The sha256-chained journal is **tamper-evident**, not tamper-proof. Anyone who can rewrite the journal file can produce a new, internally consistent chain. An independent certifying witness (Ed25519 / qualified timestamp) is planned and is **not included** in this repository.
- This is not a qualified electronic timestamp, not an eIDAS service, and not legal advice.

## Practical limits

- Only relative `.md` paths inside `XVCACHE_VAULT` are accepted. Absolute paths, `..` segments, and writes through symbolic links are rejected.
- The journal records tool name, arguments (path, query, mode — not note content), a client name, a result, and optional `note_sha256` fingerprints. Do not put secrets in note **paths**.
- `verify_journal` is not written into the journal.
- The journal file must stay **outside** the vault (`XVCACHE_LOG`).
- `write_note` accepts at most 256 KiB per call.
- The server speaks MCP over STDIO only. It does not open a network port.

## Reporting a vulnerability

Do not open a public issue with exploit details.

Once a public GitHub repository exists, use GitHub's private vulnerability reporting on that repository. Until then, do not publish a report in a public channel.

Please include the version (`0.1.0` or the git revision), what you did, and what you observed. Allow time for a fix before any public disclosure.
