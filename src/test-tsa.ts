/** Test helper: a local RFC 3161 TSA backed by `openssl ts -reply` with a throwaway CA. Not shipped. */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type FakeTsa = { url: string; caFile: string; dir: string; requests: number; close(): Promise<void> };

/** `policy`: TSTInfo policy OID the fake TSA puts in its tokens (default 1.2.3.4.99, not qualified). */
export async function startFakeTsa(opts: { policy?: string } = {}): Promise<FakeTsa> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-faketsa-"));
  const p = (f: string) => path.join(dir, f);
  await fs.writeFile(p("ext.cnf"), "[tsa_ext]\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", p("ca.key"), "-out", p("ca.crt"), "-days", "2", "-subj", "/CN=XVcache Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  await run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", p("tsa.key"), "-out", p("tsa.csr"), "-subj", "/CN=XVcache Test TSA"]);
  await run("openssl", ["x509", "-req", "-in", p("tsa.csr"), "-CA", p("ca.crt"), "-CAkey", p("ca.key"), "-CAcreateserial", "-out", p("tsa.crt"), "-days", "2", "-extfile", p("ext.cnf"), "-extensions", "tsa_ext"]);
  await fs.writeFile(p("serial"), "01\n");
  await fs.writeFile(p("tsa.cnf"), [
    "[ tsa ]", "default_tsa = tsa1", "[ tsa1 ]",
    `serial = ${p("serial")}`, "crypto_device = builtin",
    `signer_cert = ${p("tsa.crt")}`, `certs = ${p("ca.crt")}`, `signer_key = ${p("tsa.key")}`,
    "signer_digest = sha256", `default_policy = ${opts.policy ?? "1.2.3.4.99"}`, "digests = sha256",
    "accuracy = secs:1", "ordering = no", "tsa_name = no", "ess_cert_id_chain = no", "ess_cert_id_alg = sha256", "",
  ].join("\n"));
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      try {
        const id = ++n;
        const q = p(`q${id}.tsq`), r = p(`r${id}.tsr`);
        await fs.writeFile(q, Buffer.concat(chunks));
        await run("openssl", ["ts", "-reply", "-config", p("tsa.cnf"), "-queryfile", q, "-out", r]);
        res.writeHead(200, { "Content-Type": "application/timestamp-reply" });
        res.end(await fs.readFile(r));
        fake.requests++;
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  const fake: FakeTsa = {
    url: `http://127.0.0.1:${addr.port}/tsr`,
    caFile: p("ca.crt"),
    dir,
    requests: 0,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
  return fake;
}
