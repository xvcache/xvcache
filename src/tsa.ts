import { randomBytes } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseDer, derValue, derRaw, decodeOid, tlv, encodeOid, encodePositiveInteger, generalizedTimeToIso,
  type DerNode,
} from "./der.js";

/** RFC 3161 Time-Stamp Authority client with pluggable providers. */

export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";

export type TsaProvider = {
  id: "freetsa" | "certigna" | "custom";
  label: string;
  url: string;
  qualified: boolean;
  qualifiedBasis: string;
  user?: string;
  password?: string;
  caFile?: string;
  untrustedFile?: string;
};

export type TsaConfigError = { error: string };

export function certsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "certs");
}

export const FREETSA_URL = "https://freetsa.org/tsr";
export const CERTIGNA_URL = "https://timestamp.dhimyotis.com/api/v1/";

/**
 * Provider selection (env):
 * - XVCACHE_TSA_PROVIDER = freetsa | certigna | custom | off
 *   default: certigna when XVCACHE_TSA_USER is set, otherwise freetsa (test, non qualifié).
 * - XVCACHE_TSA_URL, XVCACHE_TSA_USER, XVCACHE_TSA_PASSWORD (HTTP Basic), XVCACHE_TSA_CA_FILE,
 *   XVCACHE_TSA_UNTRUSTED_FILE (intermediate certs, optional), XVCACHE_TSA_QUALIFIED (custom only).
 * Secrets are read from the environment only and are never written to proofs or logs.
 */
export function resolveTsaProvider(env: NodeJS.ProcessEnv = process.env): TsaProvider | null | TsaConfigError {
  const wanted = (env.XVCACHE_TSA_PROVIDER || (env.XVCACHE_TSA_USER ? "certigna" : "freetsa")).toLowerCase();
  const caOverride = env.XVCACHE_TSA_CA_FILE || undefined;
  const untrusted = env.XVCACHE_TSA_UNTRUSTED_FILE || undefined;
  if (wanted === "off" || wanted === "none") return null;
  if (wanted === "freetsa") {
    return {
      id: "freetsa",
      label: "FreeTSA (test, non qualifié)",
      url: env.XVCACHE_TSA_URL || FREETSA_URL,
      qualified: false,
      qualifiedBasis: "FreeTSA n'est pas un prestataire qualifié eIDAS : jeton de test, sans présomption légale.",
      caFile: caOverride ?? path.join(certsDir(), "freetsa-cacert.pem"),
      untrustedFile: untrusted,
    };
  }
  if (wanted === "certigna") {
    if (!env.XVCACHE_TSA_USER || !env.XVCACHE_TSA_PASSWORD) {
      return { error: "Certigna : XVCACHE_TSA_USER et XVCACHE_TSA_PASSWORD sont requis (compte utilisateur Horodatage)." };
    }
    return {
      id: "certigna",
      label: "Certigna (horodatage qualifié eIDAS)",
      url: env.XVCACHE_TSA_URL || CERTIGNA_URL,
      qualified: true,
      qualifiedBasis: "Certigna est prestataire de services de confiance qualifié (ANSSI) pour l'horodatage électronique : présomption d'exactitude de la date et d'intégrité (eIDAS, art. 41).",
      user: env.XVCACHE_TSA_USER,
      password: env.XVCACHE_TSA_PASSWORD,
      // Bundled public chain from https://www.certigna.com/autorites-de-certification/
      // (fingerprints checked against that page). Override with XVCACHE_TSA_CA_FILE /
      // XVCACHE_TSA_UNTRUSTED_FILE if needed.
      caFile: caOverride ?? path.join(certsDir(), "certigna-chain.pem"),
      untrustedFile: untrusted ?? path.join(certsDir(), "certigna-untrusted.pem"),
    };
  }
  if (wanted === "custom") {
    if (!env.XVCACHE_TSA_URL) return { error: "Fournisseur custom : XVCACHE_TSA_URL est requis." };
    const declared = env.XVCACHE_TSA_QUALIFIED === "true" || env.XVCACHE_TSA_QUALIFIED === "1";
    return {
      id: "custom",
      label: declared ? "TSA personnalisée (déclarée qualifiée par l'opérateur)" : "TSA personnalisée (non qualifiée)",
      url: env.XVCACHE_TSA_URL,
      qualified: declared,
      qualifiedBasis: declared
        ? "Qualification déclarée par l'opérateur via XVCACHE_TSA_QUALIFIED, non vérifiée par XVcache."
        : "Aucune qualification eIDAS déclarée.",
      user: env.XVCACHE_TSA_USER || undefined,
      password: env.XVCACHE_TSA_PASSWORD || undefined,
      caFile: caOverride,
      untrustedFile: untrusted,
    };
  }
  return { error: `XVCACHE_TSA_PROVIDER inconnu : ${wanted} (freetsa, certigna, custom, off).` };
}

export function buildTimeStampReq(digest: Buffer, nonce: Buffer): Buffer {
  if (digest.length !== 32) throw new Error("TSA : empreinte SHA-256 attendue (32 octets).");
  const algId = tlv(0x30, Buffer.concat([encodeOid(OID_SHA256), Buffer.from([0x05, 0x00])]));
  const imprint = tlv(0x30, Buffer.concat([algId, tlv(0x04, digest)]));
  return tlv(0x30, Buffer.concat([
    Buffer.from([0x02, 0x01, 0x01]),
    imprint,
    encodePositiveInteger(nonce),
    Buffer.from([0x01, 0x01, 0xff]), // certReq TRUE: the TSA certificate is embedded in the token
  ]));
}

export type TstInfo = {
  policy: string;
  hashAlgorithm: string;
  messageImprint: string;
  serial: string;
  genTime: string;
  nonce: string | null;
};

function intHex(buf: Buffer, n: DerNode): string {
  let v = derValue(buf, n);
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  return v.toString("hex");
}

/** Parse a TimeStampToken (CMS ContentInfo, DER) and return its TSTInfo. */
export function parseTimeStampToken(token: Buffer): TstInfo {
  const ci = parseDer(token);
  if (ci.end !== token.length) throw new Error("TSA : octets en trop après le jeton.");
  const c = ci.children ?? [];
  if (c.length < 2 || c[0].tag !== 0x06 || decodeOid(derValue(token, c[0])) !== OID_SIGNED_DATA) {
    throw new Error("TSA : le jeton n'est pas un CMS SignedData.");
  }
  const sd = c[1].children?.[0];
  const encap = sd?.children?.[2];
  const ec = encap?.children ?? [];
  if (!sd || ec.length < 2 || decodeOid(derValue(token, ec[0])) !== OID_TST_INFO) {
    throw new Error("TSA : contenu TSTInfo absent.");
  }
  const octet = ec[1].children?.[0];
  if (!octet || octet.tag !== 0x04) throw new Error("TSA : TSTInfo mal encodé.");
  const tst = derValue(token, octet);
  const t = parseDer(tst);
  const f = t.children ?? [];
  if (f.length < 5) throw new Error("TSA : TSTInfo incomplet.");
  const mi = f[2].children ?? [];
  const alg = mi[0]?.children?.[0];
  if (!alg || mi.length < 2) throw new Error("TSA : messageImprint invalide.");
  let nonce: string | null = null;
  for (const extra of f.slice(5)) {
    if (extra.tag === 0x02) { nonce = intHex(tst, extra); break; }
  }
  return {
    policy: decodeOid(derValue(tst, f[1])),
    hashAlgorithm: decodeOid(derValue(tst, alg)),
    messageImprint: derValue(tst, mi[1]).toString("hex"),
    serial: intHex(tst, f[3]),
    genTime: generalizedTimeToIso(derValue(tst, f[4]).toString("latin1")),
    nonce,
  };
}

export type TimeStampResult = { token: Buffer; info: TstInfo };

/** Parse a TimeStampResp, check status, imprint and nonce. */
export function parseTimeStampResp(resp: Buffer, digest: Buffer, nonce: Buffer): TimeStampResult {
  const r = parseDer(resp);
  const c = r.children ?? [];
  const statusNode = c[0]?.children?.[0];
  if (!statusNode || statusNode.tag !== 0x02) throw new Error("TSA : réponse illisible.");
  const status = derValue(resp, statusNode).readUIntBE(0, Math.min(derValue(resp, statusNode).length, 4));
  if (status !== 0 && status !== 1) throw new Error(`TSA : requête refusée (PKIStatus ${status}).`);
  if (!c[1]) throw new Error("TSA : aucun jeton dans la réponse.");
  const token = Buffer.from(derRaw(resp, c[1]));
  const info = parseTimeStampToken(token);
  if (info.hashAlgorithm !== OID_SHA256) throw new Error("TSA : algorithme d'empreinte inattendu.");
  if (info.messageImprint !== digest.toString("hex")) throw new Error("TSA : l'empreinte signée ne correspond pas à la racine.");
  let expectedNonce = Buffer.from(nonce);
  while (expectedNonce.length > 1 && expectedNonce[0] === 0) expectedNonce = expectedNonce.subarray(1);
  if (info.nonce !== expectedNonce.toString("hex")) throw new Error("TSA : nonce inattendu (rejeu possible).");
  return { token, info };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export async function requestTimestamp(provider: TsaProvider, digestHex: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<TimeStampResult> {
  const digest = Buffer.from(digestHex, "hex");
  let nonce = randomBytes(8);
  if (nonce[0] === 0) nonce[0] = 1;
  const body = buildTimeStampReq(digest, nonce);
  const headers: Record<string, string> = { "Content-Type": "application/timestamp-query", Accept: "application/timestamp-reply" };
  if (provider.user && provider.password) {
    headers.Authorization = "Basic " + Buffer.from(`${provider.user}:${provider.password}`, "utf8").toString("base64");
  }
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const res = await f(provider.url, { method: "POST", headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 20000) });
  if (!res.ok) {
    // Certigna guide: 401/403 = bad credentials or forbidden; 402 = credits exhausted.
    const hint = res.status === 401 || res.status === 403 ? " (identifiants refusés)"
      : res.status === 402 ? " (pack de jetons épuisé)"
      : "";
    throw new Error(`TSA ${provider.id} : HTTP ${res.status}${hint}.`);
  }
  return parseTimeStampResp(Buffer.from(await res.arrayBuffer()), digest, nonce);
}

export type SignatureCheck = { status: "verified" | "failed" | "unavailable"; detail: string };

/** Verify the CMS signature and TSA certificate chain with `openssl ts -verify`. */
export async function verifyTokenSignature(token: Buffer, digestHex: string, caFile?: string, untrustedFile?: string): Promise<SignatureCheck> {
  if (!caFile) return { status: "unavailable", detail: "Aucun certificat racine configuré pour ce fournisseur (XVCACHE_TSA_CA_FILE)." };
  if (!existsSync(caFile)) return { status: "unavailable", detail: `Certificat racine introuvable : ${caFile}` };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-tsv-"));
  try {
    const tokFile = path.join(dir, "token.der");
    await fs.writeFile(tokFile, token);
    const args = ["ts", "-verify", "-token_in", "-in", tokFile, "-digest", digestHex, "-CAfile", caFile];
    if (untrustedFile) args.push("-untrusted", untrustedFile);
    return await new Promise<SignatureCheck>((resolve) => {
      execFile("openssl", args, { timeout: 15000 }, (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`;
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ status: "unavailable", detail: "openssl introuvable : signature non vérifiée." });
        } else if (!err && /Verification: OK/.test(out)) {
          resolve({ status: "verified", detail: "Signature TSA et chaîne de certificats valides (openssl ts -verify)." });
        } else {
          const line = out.split("\n").find((l) => /error|FAILED|Verification/i.test(l)) ?? "échec";
          resolve({ status: "failed", detail: `Signature TSA invalide : ${line.trim().slice(0, 200)}` });
        }
      });
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
