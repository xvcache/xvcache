import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Public texts shipped in the npm tarball must not name Certigna or Dhimyotis,
 * and must not print the qualified policy OID in public wording.
 *
 * Explicit exceptions (technical, not public copy):
 * - certs/certigna-*.pem (trust anchors; the CA name is inside the certificates;
 *   renaming the shipped files would break existing installs)
 * - technical identifiers in packed JS: certignaTrust, CERTIGNA_* constants,
 *   legacy provider id "certigna", pem filenames, the TSA API host, and the
 *   policy OID used to assess a token (the OID may still appear in a PDF and
 *   in technical JSON fields, not in explanatory text).
 *
 * This file uses only Node/npm APIs present on 2105f98: it must compile and
 * fail its assertions on that commit, then pass after the public-text fix.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = /certigna|dhimyotis|1\.2\.250/gi;

const PEM_ALLOW = new Set(["package/certs/certigna-chain.pem", "package/certs/certigna-untrusted.pem"]);

const TECHNICAL_TOKENS = [
  "certignaTrust",
  "CERTIGNA_QUALIFIED_POLICY_OID",
  "CERTIGNA_URL",
  "QUALIFIED_TSA_URL",
  "isQualifiedTsaId",
  "certigna-chain.pem",
  "certigna-untrusted.pem",
  "timestamp.dhimyotis.com",
  "1.2.250.1.177.2.9.1",
];

let tmp = "";
let extractDir = "";

function npmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (
      lower === "npm_token" ||
      lower === "npm_publish_token" ||
      lower.startsWith("npm_package_") ||
      lower.startsWith("npm_lifecycle_") ||
      lower === "npm_command" ||
      lower === "init_cwd" ||
      lower === "npm_config_local_prefix"
    ) {
      delete env[key];
    }
  }
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  env.npm_config_update_notifier = "false";
  env.npm_config_progress = "false";
  return env;
}

function run(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    const timer = opts.timeoutMs ? setTimeout(() => { child.kill("SIGKILL"); }, opts.timeoutMs) : undefined;
    child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

/** The quoted JS/JSON string that contains index, if any. */
function enclosingQuote(text: string, index: number): string | null {
  const openers = ['"', "'", "`"];
  for (let i = index; i >= 0; i--) {
    if (openers.includes(text[i])) {
      const q = text[i];
      let j = index;
      while (j < text.length) {
        if (text[j] === q && text[j - 1] !== "\\") return text.slice(i + 1, j);
        j++;
      }
      return null;
    }
    if (text[i] === "\n") break;
  }
  return null;
}

function isTechnicalHit(rel: string, text: string, index: number, matched: string): string | null {
  if (PEM_ALLOW.has(rel)) return "shipped trust-anchor PEM (CA name in the certificates; do not rename)";
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + matched.length + 80);
  const window = text.slice(start, end);
  for (const tok of TECHNICAL_TOKENS) {
    const at = window.toLowerCase().indexOf(tok.toLowerCase());
    if (at >= 0) {
      const abs = start + at;
      if (index >= abs && index < abs + tok.length) return `technical identifier ${tok}`;
    }
  }
  const quoted = enclosingQuote(text, index);
  if (quoted && /^(certigna)$/i.test(quoted.trim())) return "legacy provider id or trust.name (technical field)";
  // package.json "files" / path mentions of the shipped pem names
  if (/(?:^|\/)certs\/certigna-(?:chain|untrusted)\.pem$/.test(quoted ?? "") || /certs\/certigna-(?:chain|untrusted)\.pem/.test(window)) {
    if (/certigna-(?:chain|untrusted)\.pem/i.test(matched) || matched.toLowerCase() === "certigna") {
      return "shipped pem path";
    }
  }
  return null;
}

before(async () => {
  assert.ok(existsSync(path.join(repoRoot, "dist", "server.js")), "run `npm run build` first");
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-public-texts-"));
  const packed = await run("npm", ["pack", "--pack-destination", tmp], { cwd: repoRoot, env: npmEnv(), timeoutMs: 60_000 });
  assert.equal(packed.code, 0, `npm pack failed: ${packed.stdout}\n${packed.stderr}`);
  const name = packed.stdout.trim().split("\n").pop()?.trim();
  assert.ok(name && name.endsWith(".tgz"), `npm pack did not print a tgz name:\n${packed.stdout}\n${packed.stderr}`);
  const tgz = path.join(tmp, path.basename(name));
  extractDir = path.join(tmp, "extract");
  await fs.mkdir(extractDir, { recursive: true });
  const extracted = await run("tar", ["-xzf", tgz, "-C", extractDir], { timeoutMs: 15_000 });
  assert.equal(extracted.code, 0, `tar extract failed: ${extracted.stderr}`);
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("packed public texts do not name Certigna, Dhimyotis, or the policy OID (except listed technical exceptions)", async () => {
  const hits: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = path.relative(extractDir, full).split(path.sep).join("/");
      const buf = await fs.readFile(full);
      // Search UTF-8 text and also Latin-1-ish binary (PEM/PDF) as utf8 replacement.
      const text = buf.toString("utf8");
      FORBIDDEN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FORBIDDEN.exec(text))) {
        const why = isTechnicalHit(rel, text, m.index, m[0]);
        if (why) continue;
        const line = text.slice(0, m.index).split("\n").length;
        const snippet = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, " ").trim();
        hits.push(`${rel}:${line}: ${snippet}`);
      }
    }
  }
  await walk(extractDir);
  assert.equal(hits.length, 0, `forbidden public-text hits in the npm tarball (${hits.length}):\n${hits.join("\n")}`);
});

test("the npm tarball ships only locales/en.json and locales/fr.json", async () => {
  const locDir = path.join(extractDir, "package", "locales");
  const names = (await fs.readdir(locDir)).filter((n) => n.endsWith(".json")).sort();
  assert.deepEqual(names, ["en.json", "fr.json"], `unexpected locales in the tarball: ${names.join(", ")}`);
});
