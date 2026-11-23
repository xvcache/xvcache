import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards A1: the published npm tarball must contain every relative import of
 * the shipped bins (and every other packed .js/.mjs), and an install from the
 * tgz must load those bins without ERR_MODULE_NOT_FOUND.
 *
 * None of the three bins implement --help:
 *   - xvcache-remote (--help) starts a server (bind 127.0.0.1:0, then we stop it)
 *   - xvcache-mcp exits 1 if XVCACHE_VAULT is missing (after imports)
 *   - xvcache-certificate exits 1 with its usage line (after imports)
 * So "loads without ERR_MODULE_NOT_FOUND" is the contract, not a zero exit.
 *
 * No production / Stripe live / real TSA traffic: TSA off, OTS off, billing
 * unset, isolated data dir and HOME.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELATIVE_IMPORT = /(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g;
const MODULE_NOT_FOUND = "ERR_MODULE_NOT_FOUND";

let tmp = "";
let tgz = "";
let packedNames: string[] = [];

function npmEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
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
  return { ...env, ...extra };
}

function run(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill("SIGKILL"); }, opts.timeoutMs)
      : undefined;
    child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

function combined(r: { stdout: string; stderr: string }): string {
  return `${r.stdout}\n${r.stderr}`;
}

async function listTarball(file: string): Promise<string[]> {
  const r = await run("tar", ["-tzf", file], { timeoutMs: 15_000 });
  assert.equal(r.code, 0, `tar -tzf failed: ${r.stderr}`);
  return r.stdout.split("\n").map((l) => l.replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean);
}

function relativeImports(source: string): string[] {
  return [...source.matchAll(RELATIVE_IMPORT)].map((m) => m[1]);
}

before(async () => {
  assert.ok(
    existsSync(path.join(repoRoot, "dist", "remote-server.js")),
    "dist/remote-server.js is missing; run `npm run build` first",
  );
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-pack-"));
  const packed = await run("npm", ["pack", "--pack-destination", tmp], {
    cwd: repoRoot,
    env: npmEnv(),
    timeoutMs: 60_000,
  });
  assert.equal(packed.code, 0, `npm pack failed: ${combined(packed)}`);
  const name = packed.stdout.trim().split("\n").pop()?.trim();
  assert.ok(name && name.endsWith(".tgz"), `npm pack did not print a tgz name:\n${combined(packed)}`);
  tgz = path.join(tmp, path.basename(name));
  assert.ok(existsSync(tgz), `packed tgz not found: ${tgz}`);
  packedNames = await listTarball(tgz);
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("npm pack tarball contains every relative import of packed dist and bin files", async () => {
  const packed = new Set(packedNames);
  const jsFiles = packedNames.filter((n) => n.endsWith(".js") || n.endsWith(".mjs"));
  assert.ok(jsFiles.includes("package/dist/remote-server.js"), "tarball is missing the xvcache-remote bin");
  assert.ok(jsFiles.includes("package/dist/server.js"), "tarball is missing the xvcache-mcp bin");
  assert.ok(jsFiles.includes("package/dist/export-certificate.js"), "tarball is missing the xvcache-certificate bin");

  const extractDir = path.join(tmp, "extract");
  await fs.mkdir(extractDir, { recursive: true });
  const extracted = await run("tar", ["-xzf", tgz, "-C", extractDir], { timeoutMs: 15_000 });
  assert.equal(extracted.code, 0, `tar extract failed: ${extracted.stderr}`);

  const missing: string[] = [];
  for (const rel of jsFiles) {
    const source = await fs.readFile(path.join(extractDir, rel), "utf8");
    for (const spec of relativeImports(source)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!packed.has(target) && !packed.has(target + ".js")) {
        missing.push(`${rel} imports ${spec} -> ${target} is not in the tarball`);
      }
    }
  }
  assert.equal(missing.length, 0, missing.join("\n"));
});

test("installed pack: remote-server --help and the other bins load without ERR_MODULE_NOT_FOUND", async () => {
  const installDir = path.join(tmp, "install");
  await fs.mkdir(installDir, { recursive: true });
  // Empty-dir install: a private package.json stops npm from walking up to `/`.
  await fs.writeFile(path.join(installDir, "package.json"), `${JSON.stringify({
    name: "xvcache-pack-smoke",
    private: true,
    version: "0.0.0",
  })}
`);

  const installArgs = ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDir, tgz];
  let installed = await run("npm", [...installArgs, "--offline"], {
    cwd: installDir,
    env: npmEnv(),
    timeoutMs: 60_000,
  });
  if (installed.code !== 0) {
    installed = await run("npm", installArgs, {
      cwd: installDir,
      env: npmEnv(),
      timeoutMs: 120_000,
    });
  }
  assert.equal(installed.code, 0, `npm install of the tgz failed:\n${combined(installed)}`);

  const pkgRoot = path.join(installDir, "node_modules", "xvcache-mcp");
  const remoteBin = path.join(pkgRoot, "dist", "remote-server.js");
  const serverBin = path.join(pkgRoot, "dist", "server.js");
  const certBin = path.join(pkgRoot, "dist", "export-certificate.js");
  assert.ok(existsSync(remoteBin), "installed package is missing dist/remote-server.js");

  const isolatedHome = path.join(tmp, "home");
  const remoteData = path.join(tmp, "remote-data");
  await fs.mkdir(isolatedHome, { recursive: true });

  const remote = await runListeningBin(process.execPath, [remoteBin, "--help"], {
    cwd: installDir,
    env: npmEnv({
      HOME: isolatedHome,
      XVCACHE_REMOTE_HOST: "127.0.0.1",
      XVCACHE_REMOTE_PORT: "0",
      XVCACHE_REMOTE_DATA: remoteData,
      // Hosted mode refuses off: fake qualified credentials, TSA URL on a closed local port.
      // Startup never contacts the TSA (stamps happen only when a batch is flushed), and
      // even if one were attempted, 127.0.0.1:9 keeps every request on this machine.
      XVCACHE_TSA_PROVIDER: "qualified",
      XVCACHE_TSA_URL: "http://127.0.0.1:9/tsr",
      XVCACHE_OTS: "off",
      XVCACHE_RETRY_MS: "0",
      XVCACHE_ANCHOR_MODE: "window",
      XVCACHE_KEY_EMAIL: "off",
      XVCACHE_SALES_OPEN: "",
      XVCACHE_STRIPE_PAYMENT_LINK_URL: "",
      XVCACHE_STRIPE_ALLOW_TEST_CHECKOUT: "",
      STRIPE_WEBHOOK_SECRET: "",
      XVCACHE_TSA_USER: "xvcache-fake-tsa-user",
      XVCACHE_TSA_PASSWORD: "FAKE_TSA_PASSWORD_PACK_TEST",
      XVCACHE_PUBLIC_URL: "",
    }),
  });
  assert.doesNotMatch(combined(remote), /FAKE_TSA_PASSWORD_PACK_TEST/);
  assert.doesNotMatch(combined(remote), /ECONNREFUSED|ENOTFOUND|fetch failed|getaddrinfo/i);
  assert.doesNotMatch(combined(remote), new RegExp(MODULE_NOT_FOUND));
  assert.ok(
    /xvcache-remote listening on /i.test(combined(remote)),
    `xvcache-remote --help did not reach listen (and has no --help flag; it starts the server):\n${combined(remote)}`,
  );

  const server = await run(process.execPath, [serverBin, "--help"], {
    cwd: installDir,
    env: npmEnv({ HOME: isolatedHome }),
    timeoutMs: 15_000,
  });
  assert.doesNotMatch(combined(server), new RegExp(MODULE_NOT_FOUND));
  assert.ok(
    /XVCACHE_VAULT manquant/.test(combined(server)),
    `xvcache-mcp --help should exit after imports with a missing-vault message:\n${combined(server)}`,
  );
  assert.notEqual(server.code, null);

  const cert = await run(process.execPath, [certBin, "--help"], {
    cwd: installDir,
    env: npmEnv({ HOME: isolatedHome }),
    timeoutMs: 15_000,
  });
  assert.doesNotMatch(combined(cert), new RegExp(MODULE_NOT_FOUND));
  assert.ok(
    /Usage/.test(combined(cert)),
    `xvcache-certificate --help should print usage after imports:\n${combined(cert)}`,
  );
  assert.notEqual(cert.code, null);
});

/** --help on xvcache-remote starts the HTTP server; stop it once it is listening. */
function runListeningBin(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    };
    const onData = (chunk: Buffer) => {
      const text = Buffer.concat([...out, ...err, chunk]).toString("utf8");
      if (text.includes(MODULE_NOT_FOUND) || /xvcache-remote listening on /i.test(text)) {
        stop(child);
      }
    };
    child.stdout.on("data", (d: Buffer) => { out.push(d); onData(d); });
    child.stderr.on("data", (d: Buffer) => { err.push(d); onData(d); });
    const timer = setTimeout(() => stop(child, true), timeoutMs);
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

function stop(child: ChildProcess, force = false): void {
  if (child.killed || child.exitCode !== null) return;
  if (force) {
    child.kill("SIGKILL");
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }, 3_000).unref();
}
