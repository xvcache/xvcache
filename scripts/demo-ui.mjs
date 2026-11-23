#!/usr/bin/env node
// Local lawyer demo: drop a file, get Intact + PDF or "Modifié depuis le …".
// Listens on 127.0.0.1 only. Does not spend a qualified timestamp token (stamp is off
// unless XVCACHE_DEMO_STAMP=1). Password is never read from a file.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../dist/env.js";
import { resolveTsaProvider } from "../dist/tsa.js";
import { Certifier, certifyConfigFromEnv } from "../dist/certify.js";
import { startDemoServer } from "../dist/demo-server.js";

loadLocalEnv();

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  if (hit) return hit.slice(pref.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return undefined;
}

const vaultEnv = arg("vault") || process.env.XVCACHE_VAULT || process.env.JAYCACHE_VAULT;
if (!vaultEnv) {
  console.error("XVCACHE_VAULT manquant (ou --vault).");
  process.exit(1);
}
const vaultRoot = await fs.realpath(path.resolve(vaultEnv));
const journalPath = (arg("log") || process.env.XVCACHE_LOG || process.env.JAYCACHE_LOG)
  ? path.resolve(arg("log") || process.env.XVCACHE_LOG || process.env.JAYCACHE_LOG)
  : path.resolve(vaultRoot, "..", "xvcache-journal.jsonl");
const tsaResolved = resolveTsaProvider();
const tsa = tsaResolved && !("error" in tsaResolved) ? tsaResolved : null;
const certifier = new Certifier(certifyConfigFromEnv({ vaultRoot, journalPath, tsa }));

const host = arg("host") || "127.0.0.1";
const port = Number(arg("port") || process.env.XVCACHE_DEMO_PORT || 8765);
const stamp = process.env.XVCACHE_DEMO_STAMP === "1" || process.argv.includes("--stamp");

const { url } = await startDemoServer({ certifier, host, port, stamp });
console.log(`Démo XVcache : ${url}`);
console.log(`Coffre : ${vaultRoot}`);
console.log("Écoute limitée à cet ordinateur. Ctrl+C pour arrêter.");
console.log(`Répertoire du code : ${repo}`);
