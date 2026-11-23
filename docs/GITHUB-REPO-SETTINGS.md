# Proposed GitHub repository settings (not applied)

Apply manually in GitHub → Settings, or with `gh repo edit`, only after approval.

**Description** (≤ 350 chars):
Prove the date and integrity of a document in Europe. MCP server: V/X verdict, PDF certificate, eIDAS-qualified timestamps (art. 41). Content never leaves your machine. For lawyers, accountants, architects, researchers, SMEs.

**Website**: https://www.npmjs.com/package/xvcache-mcp until https://xvcache.com is online, then https://xvcache.com.

**Topics** (GitHub max 20):
mcp, mcp-server, model-context-protocol, eidas, qualified-timestamp, timestamping, rfc3161, opentimestamps, proof-of-existence, document-integrity, tamper-evident, audit-trail,  legaltech, intellectual-property, compliance, ai-agents, claude, cursor, obsidian

**Social preview**: upload `docs/social-preview.png` (1280×640) in Settings → General → Social preview.

Command once approved:
```bash
gh repo edit xvcache/xvcache --description "…" --homepage "https://www.npmjs.com/package/xvcache-mcp" \
  --add-topic mcp,mcp-server,model-context-protocol,eidas,qualified-timestamp,timestamping,rfc3161,opentimestamps,proof-of-existence,document-integrity,tamper-evident,audit-trail,legaltech,intellectual-property,compliance,ai-agents,claude,cursor,obsidian
```
(The social preview image can only be uploaded through the web UI.)
