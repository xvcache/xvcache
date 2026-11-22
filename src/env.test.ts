import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnvFile, loadLocalEnv, ENV_FILE_FORBIDDEN } from "./env.js";
import { resolveTsaProvider, requestTimestamp, type TsaProvider } from "./tsa.js";

const USER_WITH_HASH_AND_SPACE = "ACME AVOCATS#API- OK";

test("parseEnvFile keeps # and spaces inside quotes, strips unquoted comments", () => {
  const parsed = parseEnvFile([
    "# comment",
    "XVCACHE_TSA_PROVIDER=certigna",
    `XVCACHE_TSA_USER="${USER_WITH_HASH_AND_SPACE}"`,
    "QUOTED_SINGLE='a # b'",
    "UNQUOTED=value # trailing",
    "export ALSO=ok",
    "",
    "XVCACHE_TSA_PASSWORD=must-be-parsed-but-never-applied",
  ].join("\n"));
  assert.equal(parsed.XVCACHE_TSA_PROVIDER, "certigna");
  assert.equal(parsed.XVCACHE_TSA_USER, USER_WITH_HASH_AND_SPACE);
  assert.equal(parsed.QUOTED_SINGLE, "a # b");
  assert.equal(parsed.UNQUOTED, "value");
  assert.equal(parsed.ALSO, "ok");
  assert.equal(parsed.XVCACHE_TSA_PASSWORD, "must-be-parsed-but-never-applied");
});

test("loadLocalEnv reads .env.local, ignores password, does not overwrite existing env", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-env-"));
  try {
    await fs.writeFile(path.join(dir, ".env"), "XVCACHE_TSA_PROVIDER=freetsa\nFROM_ENV=yes\n");
    await fs.writeFile(path.join(dir, ".env.local"), [
      "XVCACHE_TSA_PROVIDER=certigna",
      `XVCACHE_TSA_USER="${USER_WITH_HASH_AND_SPACE}"`,
      "XVCACHE_TSA_PASSWORD=should-never-land-in-env",
      "FROM_LOCAL=yes",
    ].join("\n") + "\n");
    const env: NodeJS.ProcessEnv = { FROM_ENV: "already" };
    const results = loadLocalEnv(env, { dirs: [dir] });
    assert.ok(results.some((r) => r.file.endsWith(".env.local")));
    assert.equal(env.XVCACHE_TSA_PROVIDER, "certigna");
    assert.equal(env.XVCACHE_TSA_USER, USER_WITH_HASH_AND_SPACE);
    assert.equal(env.FROM_LOCAL, "yes");
    assert.equal(env.FROM_ENV, "already", "existing values are kept");
    assert.equal(env.XVCACHE_TSA_PASSWORD, undefined);
    const local = results.find((r) => r.file.endsWith(".env.local"))!;
    assert.ok(local.skipped.includes("XVCACHE_TSA_PASSWORD"));
    assert.ok(ENV_FILE_FORBIDDEN.has("XVCACHE_TSA_PASSWORD"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Basic Auth encodes a Certigna user that contains # and a space", async () => {
  const password = "not-the-real-password/#x";
  const provider = resolveTsaProvider({
    XVCACHE_TSA_PROVIDER: "certigna",
    XVCACHE_TSA_USER: USER_WITH_HASH_AND_SPACE,
    XVCACHE_TSA_PASSWORD: password,
  }) as TsaProvider;
  assert.equal(provider.user, USER_WITH_HASH_AND_SPACE);
  let header: string | undefined;
  const fetchImpl = async (_url: string, init: { headers: Record<string, string> }) => {
    header = init.headers.Authorization;
    return { ok: false, status: 599, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(() => requestTimestamp(provider, "0".repeat(64), { fetchImpl }));
  assert.ok(header?.startsWith("Basic "));
  const decoded = Buffer.from(header!.slice(6), "base64").toString("utf8");
  const cut = decoded.indexOf(":");
  assert.equal(decoded.slice(0, cut), USER_WITH_HASH_AND_SPACE);
  assert.equal(decoded.slice(cut + 1), password);
  assert.match(decoded, /#/);
  assert.match(decoded.slice(0, cut), / /);
});
