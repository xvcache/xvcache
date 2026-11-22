#!/usr/bin/env node
// Demo: temp vault, 3 notes, one batched timestamp, verify V, tamper one note, verify X.
// Uses the default witness: FreeTSA (test, non qualifié) + OpenTimestamps. Only hashes leave the machine.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-demo-"));
const vault = path.join(base, "vault");
await fs.mkdir(vault);

const env = { ...process.env, XVCACHE_VAULT: vault, XVCACHE_LOG: path.join(base, "xvcache-journal.jsonl"), XVCACHE_DATA: path.join(base, ".xvcache") };
const client = new Client({ name: "xvcache-demo", version: "0.2.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [path.join(repo, "dist/server.js")], env }));
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("");
const call = async (name, args = {}) => client.callTool({ name, arguments: args });

const notes = { "Contrats/Devis-042.md": "# Devis 042\nMontant validé par l'agent.\n", "Recherche/Idee.md": "# Idée\nAntériorité.\n", "Journal/2026-11-22.md": "# Décision\nTampon groupé.\n" };
console.log(`Coffre temporaire : ${vault}`);
for (const [p, c] of Object.entries(notes)) {
  const r = await call("write_note", { path: p, content: c });
  if (r.isError) throw new Error(text(r));
  await call("certify_note", { path: p, defer: true });
}
console.log(`1) 3 notes écrites et mises en attente de certification`);

const b = await call("certify_batch");
if (b.isError) { console.error(text(b)); process.exit(1); }
const batch = JSON.parse(text(b));
console.log(`2) certify_batch : 1 seul horodatage pour ${batch.leaf_count} feuilles (3 notes + tête du journal)`);
console.log(`   racine Merkle ${batch.root}`);
console.log(`   ${batch.provider} · qualifié=${batch.qualified} · genTime ${batch.gen_time} · OpenTimestamps ${batch.ots_status}`);

for (const p of Object.keys(notes)) {
  const r = await call("verify_proof", { path: p, online: false });
  console.log(`3) ${text(r).split("\n")[0]}`);
}

await fs.appendFile(path.join(vault, "Contrats/Devis-042.md"), "Montant modifié à la main.\n");
const x = await call("verify_proof", { path: "Contrats/Devis-042.md", online: false });
console.log(`4) après retouche hors XVcache : ${text(x).split("\n")[0]}`);
const y = await call("verify_proof", { path: "Recherche/Idee.md", online: false });
console.log(`5) les autres notes du lot restent : ${text(y).split("\n")[0]}`);

const proofDir = path.join(base, ".xvcache", "proofs");
console.log(`Preuves individuelles : ${proofDir}`);
await client.close();
if (!process.argv.includes("--keep")) await fs.rm(base, { recursive: true, force: true });
const okRun = !x.isError ? false : !y.isError;
process.exit(okRun ? 0 : 1);
