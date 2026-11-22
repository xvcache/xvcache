#!/usr/bin/env node
/**
 * Export a one-page French certificate PDF from an existing proof.
 * Never stamps and never reads XVCACHE_TSA_PASSWORD from a file.
 *
 *   xvcache-certificate --path Journal/2026-11-22.md
 *   xvcache-certificate --path Contrats/Devis-042.md --file /tmp/copie.md
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "./env.js";
import { resolveTsaProvider } from "./tsa.js";
import { Certifier, certifyConfigFromEnv } from "./certify.js";
import { handleDocument } from "./certificate.js";

loadLocalEnv();

function arg(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  if (hit) return hit.slice(pref.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return undefined;
}

function envVault(): string | undefined {
  return process.env.XVCACHE_VAULT || process.env.JAYCACHE_VAULT;
}
function envLog(): string | undefined {
  return process.env.XVCACHE_LOG || process.env.JAYCACHE_LOG;
}

const rel = arg("path");
if (!rel) {
  console.error("Usage : xvcache-certificate --path <note.md> [--file <copie>] [--out <dossier>]");
  process.exit(1);
}

const vaultEnv = envVault();
if (!vaultEnv) {
  console.error("XVCACHE_VAULT manquant.");
  process.exit(1);
}
const vaultRoot = await fs.realpath(path.resolve(vaultEnv));
const journalPath = envLog() ? path.resolve(envLog()!) : path.resolve(vaultRoot, "..", "xvcache-journal.jsonl");
const tsaResolved = resolveTsaProvider();
const tsa = tsaResolved && !("error" in tsaResolved) ? tsaResolved : null;
const certifier = new Certifier(certifyConfigFromEnv({ vaultRoot, journalPath, tsa }));

const file = arg("file");
const content = file ? await fs.readFile(file) : undefined;
const result = await handleDocument(certifier, {
  path: rel,
  content,
  filename: file ? path.basename(file) : undefined,
  stamp: false,
  online: process.argv.includes("--online"),
});

if (arg("out") && result.pdf) {
  const destDir = path.resolve(arg("out")!);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(result.pdf));
  await fs.copyFile(result.pdf, dest);
  result.pdf = dest;
}

if (!result.ok) {
  console.error(result.error ?? "Échec.");
  process.exit(1);
}
const out = {
  glyph: result.glyph,
  verdict: result.verdict?.sentence,
  pdf: result.pdf,
  pack: result.pack,
  attachments: result.attachments?.map((a) => a.path),
  gen_time_paris: result.gen_time_paris,
  qualified: result.qualified,
  provider: result.provider,
};
console.log(JSON.stringify(out, null, 2));
process.exit(result.glyph === "V" || result.glyph === "X" ? 0 : 1);
