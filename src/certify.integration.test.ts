import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Certifier, certifyConfigFromEnv } from "./certify.js";
import { resolveTsaProvider, FREETSA_URL, type TsaProvider } from "./tsa.js";
import { parseOts, otsStatus, serializeOts } from "./ots.js";

async function reachable(url: string): Promise<boolean> {
  if (process.env.XVCACHE_OFFLINE === "1") return false;
  try { await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) }); return true; } catch { return false; }
}

test("integration: FreeTSA + OpenTimestamps on a real batch (skips offline)", async (t) => {
  if (!(await reachable(FREETSA_URL))) { t.skip("FreeTSA injoignable (hors ligne)"); return; }
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-int-"));
  try {
    const vault = path.join(base, "vault");
    await fs.mkdir(vault);
    for (const n of ["A", "B", "C"]) await fs.writeFile(path.join(vault, `${n}.md`), `# ${n}\n`);
    const c = new Certifier(certifyConfigFromEnv({ vaultRoot: await fs.realpath(vault), journalPath: path.join(base, "j.jsonl"), tsa: resolveTsaProvider({}) as TsaProvider }, {}));
    for (const n of ["A", "B", "C"]) await c.enqueue(n);
    const b = await c.runBatch();
    if ("error" in b) assert.fail(b.error);
    const p = b.proofs[1];
    assert.equal(p.tsa!.provider, "freetsa");
    assert.equal(p.tsa!.qualified, false);
    assert.ok(Date.parse(p.tsa!.gen_time) > Date.now() - 10 * 60_000);
    const v = await c.verify({ path: "B.md", online: false });
    assert.equal(v.glyph, "V", v.message + JSON.stringify(v.checks));
    assert.equal(v.checks.tsa_signature.ok, true, v.checks.tsa_signature.detail);
    if (p.ots) assert.equal(p.ots.status, "pending");
    await fs.appendFile(path.join(vault, "B.md"), "x");
    assert.equal((await c.verify({ path: "B.md", online: false })).glyph, "X");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("integration: a confirmed public .ots parses, round-trips and verifies against Bitcoin (skips offline)", async (t) => {
  const base = "https://raw.githubusercontent.com/opentimestamps/opentimestamps-client/master/examples/";
  if (!(await reachable("https://blockstream.info/api/blocks/tip/height"))) { t.skip("hors ligne"); return; }
  let ots: Buffer, txt: Buffer;
  try {
    ots = Buffer.from(await (await fetch(base + "hello-world.txt.ots", { signal: AbortSignal.timeout(10000) })).arrayBuffer());
    txt = Buffer.from(await (await fetch(base + "hello-world.txt", { signal: AbortSignal.timeout(10000) })).arrayBuffer());
  } catch { t.skip("exemple OTS injoignable"); return; }
  const ts = parseOts(ots);
  assert.equal(ts.msg.toString("hex"), createHash("sha256").update(txt).digest("hex"));
  assert.ok(serializeOts(ts).equals(ots), "byte-identical re-serialization");
  const st = await otsStatus(ts, { online: true });
  if (st.status === "unverified") { t.skip("explorateurs Bitcoin injoignables"); return; }
  assert.equal(st.status, "confirmed", st.detail);
  assert.equal(st.bitcoin[0].height, 358391);
});
