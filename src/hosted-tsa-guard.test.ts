import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hosted xvcache-remote must refuse to start without qualified TSA credentials
 * (no FreeTSA fallback). Local xvcache-mcp is unchanged.
 *
 * Replay the failure on the previous commit (keep this test file):
 *   git checkout HEAD~1 -- src/tsa.ts src/remote-server.ts
 *   npm run build && node --test dist/hosted-tsa-guard.test.js
 * Then restore:
 *   git checkout HEAD -- src/tsa.ts src/remote-server.ts
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remoteBin = path.join(root, "dist", "remote-server.js");
const localBin = path.join(root, "dist", "server.js");
const FAKE_USER = "xvcache-fake-tsa-user";
const FAKE_PASSWORD = "FAKE_TSA_PASSWORD_DO_NOT_LOG_9f3c";

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(XVCACHE_|JAYCACHE_|STRIPE_|CLOUDFLARE_)/.test(k)) delete env[k];
  }
  return {
    ...env,
    XVCACHE_REMOTE_HOST: "127.0.0.1",
    XVCACHE_REMOTE_PORT: "0",
    XVCACHE_OTS: "off",
    XVCACHE_RETRY_MS: "0",
    XVCACHE_ANCHOR_MODE: "window",
    XVCACHE_KEY_EMAIL: "off",
    XVCACHE_SALES_OPEN: "",
    XVCACHE_STRIPE_PAYMENT_LINK_URL: "",
    XVCACHE_STRIPE_ALLOW_TEST_CHECKOUT: "",
    STRIPE_WEBHOOK_SECRET: "",
    XVCACHE_TSA_USER: "",
    XVCACHE_TSA_PASSWORD: "",
    XVCACHE_TSA_PROVIDER: "",
    XVCACHE_TSA_URL: "",
    XVCACHE_PUBLIC_URL: "",
    ...extra,
  };
}

function combined(r: { stdout: string; stderr: string }): string {
  return `${r.stdout}\n${r.stderr}`;
}

function assertNoSecret(text: string): void {
  assert.doesNotMatch(text, new RegExp(FAKE_PASSWORD));
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

function runProcess(
  bin: string,
  args: string[],
  opts: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeoutMs?: number;
    stopWhen?: (text: string) => boolean;
  },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    };
    const onData = (chunk: Buffer) => {
      if (!opts.stopWhen) return;
      const text = Buffer.concat([...out, ...err, chunk]).toString("utf8");
      if (opts.stopWhen(text)) stop(child);
    };
    child.stdout.on("data", (d: Buffer) => { out.push(d); onData(d); });
    child.stderr.on("data", (d: Buffer) => { err.push(d); onData(d); });
    const timer = setTimeout(() => { timedOut = true; stop(child, true); }, timeoutMs);
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

test("hosted xvcache-remote refuses to start without qualified TSA credentials", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-hosted-guard-"));
  try {
    const r = await runProcess(remoteBin, [], {
      cwd: tmp,
      env: baseEnv({
        HOME: tmp,
        XVCACHE_REMOTE_DATA: path.join(tmp, "data"),
      }),
      timeoutMs: 8_000,
      // If the old default (FreeTSA) is still in place, the process listens; stop it so the assertion fails quickly.
      stopWhen: (text) => /xvcache-remote listening on /i.test(text),
    });
    const text = combined(r);
    assert.equal(r.timedOut, false, `hosted server should exit on its own, not hang:\n${text}`);
    assert.notEqual(r.code, 0, `hosted server without TSA credentials must exit non-zero, got ${r.code}:\n${text}`);
    assert.doesNotMatch(text, /xvcache-remote listening on /i);
    assert.match(text, /XVCACHE_TSA_USER/);
    assert.match(text, /XVCACHE_TSA_PASSWORD/);
    assert.match(text, /sans repli sur FreeTSA|aucun repli/i);
    assertNoSecret(text);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("hosted xvcache-remote starts with fake qualified credentials and makes no network call at startup", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-hosted-guard-"));
  try {
    const r = await runProcess(remoteBin, [], {
      cwd: tmp,
      env: baseEnv({
        HOME: tmp,
        XVCACHE_REMOTE_DATA: path.join(tmp, "data"),
        XVCACHE_TSA_PROVIDER: "qualified",
        XVCACHE_TSA_USER: FAKE_USER,
        XVCACHE_TSA_PASSWORD: FAKE_PASSWORD,
      }),
      timeoutMs: 15_000,
      stopWhen: (text) => /xvcache-remote listening on /i.test(text),
    });
    const text = combined(r);
    assert.ok(/xvcache-remote listening on /i.test(text), `expected listen, got:\n${text}`);
    assert.equal(r.timedOut, false, `server did not reach listen:\n${text}`);
    assertNoSecret(text);
    assert.doesNotMatch(text, /ECONNREFUSED|ENOTFOUND|fetch failed|getaddrinfo/i);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("local xvcache-mcp starts without qualified TSA credentials (FreeTSA default unchanged)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-local-guard-"));
  const vault = path.join(tmp, "vault");
  await fs.mkdir(vault, { recursive: true });
  await fs.writeFile(path.join(vault, "note.md"), "# test\n");
  try {
    const r = await runProcess(localBin, [], {
      cwd: tmp,
      env: baseEnv({
        HOME: tmp,
        XVCACHE_VAULT: vault,
        XVCACHE_LOG: path.join(tmp, "journal.jsonl"),
      }),
      timeoutMs: 3_000,
    });
    const text = combined(r);
    // STDIO server stays up until we time out and SIGKILL it.
    assert.equal(r.timedOut, true, `local server should stay running, exit=${r.code}:\n${text}`);
    assert.doesNotMatch(text, /le service hébergé exige|n'est pas autorisé en mode hébergé|sans repli sur FreeTSA/);
    assert.doesNotMatch(text, /XVCACHE_VAULT manquant/);
    assertNoSecret(text);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
