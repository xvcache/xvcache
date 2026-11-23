import { randomBytes } from "node:crypto";
import { promises as fs, existsSync, readFileSync } from "node:fs";
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

/** OID of Certigna's qualified eIDAS timestamping policy (as carried in TSTInfo.policy). */
export const CERTIGNA_QUALIFIED_POLICY_OID = "1.2.250.1.177.2.9.1";

/**
 * What a token must prove to be called "qualified": a qualifying policy OID inside the token AND a
 * signer certificate issued by (and a CMS signature that validates against) this trust chain only.
 */
export type QualifiedTrust = {
  name: string;
  policyOids: string[];
  /** Trust anchors (roots) of the qualified provider. */
  caFile: string;
  /** Intermediate CAs of the qualified provider. */
  untrustedFile?: string;
};

/** The bundled Certigna chain (certs/certigna-*.pem). Not overridable from the environment. */
export function certignaTrust(): QualifiedTrust {
  return {
    name: "Certigna",
    policyOids: [CERTIGNA_QUALIFIED_POLICY_OID],
    caFile: path.join(certsDir(), "certigna-chain.pem"),
    untrustedFile: path.join(certsDir(), "certigna-untrusted.pem"),
  };
}

export type TsaProvider = {
  id: "freetsa" | "certigna" | "custom";
  label: string;
  url: string;
  /**
   * What the operator EXPECTS from this provider (used for pending_qualified and wording before a token
   * exists). It never makes a token qualified: see assessQualification(), which reads the token itself.
   */
  qualified: boolean;
  qualifiedBasis: string;
  user?: string;
  password?: string;
  caFile?: string;
  untrustedFile?: string;
  /** Chain + policy a token must match to be qualified. Default: certignaTrust(). Tests inject their own. */
  qualifiedTrust?: QualifiedTrust;
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
 *   default: certigna when XVCACHE_TSA_USER is set, otherwise freetsa (non qualifié, sans présomption légale).
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
      label: "FreeTSA (non qualifié, sans présomption légale)",
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
    // Declared qualification is only an expectation: the token must still prove it (Certigna OID + chain).
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
  /** TSTInfo.policy as read in the token; null when absent (malformed token). */
  policy: string | null;
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
  // TSTInfo ::= SEQUENCE { version INTEGER, policy OID, messageImprint, serialNumber, genTime, ... }
  // The policy is read where it is; a token without it is reported as policy: null (never a default OID).
  let i = 0;
  if (f[i]?.tag !== 0x02) throw new Error("TSA : TSTInfo incomplet.");
  i++;
  let policy: string | null = null;
  if (f[i]?.tag === 0x06) { policy = decodeOid(derValue(tst, f[i])); i++; }
  const miNode = f[i], serialNode = f[i + 1], timeNode = f[i + 2];
  if (!miNode || miNode.tag !== 0x30 || !serialNode || serialNode.tag !== 0x02 || !timeNode || timeNode.tag !== 0x18) {
    throw new Error("TSA : TSTInfo incomplet.");
  }
  const mi = miNode.children ?? [];
  const alg = mi[0]?.children?.[0];
  if (!alg || mi.length < 2) throw new Error("TSA : messageImprint invalide.");
  let nonce: string | null = null;
  for (const extra of f.slice(i + 3)) {
    if (extra.tag === 0x02) { nonce = intHex(tst, extra); break; }
  }
  return {
    policy,
    hashAlgorithm: decodeOid(derValue(tst, alg)),
    messageImprint: derValue(tst, mi[1]).toString("hex"),
    serial: intHex(tst, serialNode),
    genTime: generalizedTimeToIso(derValue(tst, timeNode).toString("latin1")),
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
export async function verifyTokenSignature(token: Buffer, digestHex: string, caFile?: string, untrustedFile?: string, opts: { openssl?: string } = {}): Promise<SignatureCheck> {
  if (!caFile) return { status: "unavailable", detail: "Aucun certificat racine configuré pour ce fournisseur (XVCACHE_TSA_CA_FILE)." };
  if (!existsSync(caFile)) return { status: "unavailable", detail: `Certificat racine introuvable : ${caFile}` };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-tsv-"));
  try {
    const tokFile = path.join(dir, "token.der");
    await fs.writeFile(tokFile, token);
    const args = ["ts", "-verify", "-token_in", "-in", tokFile, "-digest", digestHex, "-CAfile", caFile];
    if (untrustedFile) args.push("-untrusted", untrustedFile);
    return await new Promise<SignatureCheck>((resolve) => {
      execFile(opts.openssl ?? (process.env.XVCACHE_OPENSSL_BIN || "openssl"), args, { timeout: 15000 }, (err, stdout, stderr) => {
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

/* -------------------------------------------------------------------------- */
/* Qualification is read from the token, never from the configuration        */
/* -------------------------------------------------------------------------- */

const OID_CN = "2.5.4.3";
const OID_SKI = "2.5.29.14";

function pemCertificates(file: string): Buffer[] {
  if (!existsSync(file)) return [];
  const out: Buffer[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  for (const m of readFileSync(file, "utf8").matchAll(re)) out.push(Buffer.from(m[1].replace(/\s+/g, ""), "base64"));
  return out;
}

type CertNames = { issuer: Buffer; subject: Buffer; ski: string | null };

function certNames(der: Buffer, node: DerNode = parseDer(der)): CertNames {
  const tbs = node.children?.[0];
  const c = tbs?.children ?? [];
  const off = c[0]?.tag === 0xa0 ? 1 : 0;
  const issuer = c[off + 2], subject = c[off + 4];
  if (!issuer || !subject) throw new Error("certificat illisible");
  let ski: string | null = null;
  const exts = c.find((n) => n.tag === 0xa3)?.children?.[0]?.children ?? [];
  for (const e of exts) {
    const ec = e.children ?? [];
    if (ec[0]?.tag === 0x06 && decodeOid(derValue(der, ec[0])) === OID_SKI) {
      const octet = ec[ec.length - 1];
      try { ski = derValue(Buffer.from(derValue(der, octet)), parseDer(Buffer.from(derValue(der, octet)))).toString("hex"); } catch { ski = null; }
    }
  }
  return { issuer: Buffer.from(derRaw(der, issuer)), subject: Buffer.from(derRaw(der, subject)), ski };
}

/** Common name of an X.501 Name (DER), for display only. */
export function nameCommonName(name: Buffer): string | null {
  try {
    const n = parseDer(name);
    for (const rdn of n.children ?? []) for (const atv of rdn.children ?? []) {
      const [oid, val] = atv.children ?? [];
      if (oid?.tag === 0x06 && decodeOid(derValue(name, oid)) === OID_CN && val) return derValue(name, val).toString("utf8");
    }
  } catch { /* fallthrough */ }
  return null;
}

/** Issuer Name (DER) of the certificate that signed the token, from the CMS SignerInfo. */
export function tokenSignerIssuer(token: Buffer): Buffer | null {
  try {
    const ci = parseDer(token);
    const sd = ci.children?.[1]?.children?.[0];
    const sdc = sd?.children ?? [];
    const infos = [...sdc].reverse().find((n) => n.tag === 0x31);
    const si = infos?.children?.[0];
    const sid = si?.children?.[1];
    if (!sid) return null;
    if (sid.tag === 0x30) {
      const issuer = sid.children?.[0];
      return issuer ? Buffer.from(derRaw(token, issuer)) : null;
    }
    if (sid.tag === 0x80) {
      // subjectKeyIdentifier: find the embedded signer certificate, take its issuer.
      const want = derValue(token, sid).toString("hex");
      const certs = sdc.find((n) => n.tag === 0xa0)?.children ?? [];
      for (const cn of certs) {
        const der = Buffer.from(derRaw(token, cn));
        const names = certNames(der);
        if (names.ski === want) return names.issuer;
      }
    }
  } catch { /* unreadable */ }
  return null;
}

export type QualificationStatus =
  | "qualified"
  | "token_unreadable"
  | "policy_absent"
  | "policy_not_qualified"
  | "signer_not_trusted"
  | "signature_unverified"
  | "signature_invalid";

export type Qualification = {
  qualified: boolean;
  status: QualificationStatus;
  /** Policy OID actually read in the token (null = absent). */
  policy: string | null;
  /** CN of the issuer of the signing certificate, as named in the token. */
  signer_issuer: string | null;
  signature: SignatureCheck["status"] | "not_checked";
  detail: string;
};

/**
 * qualified = true only when ALL hold:
 *  1. the token carries a qualifying policy OID (Certigna: 1.2.250.1.177.2.9.1);
 *  2. the signer certificate is issued by a CA of the qualified chain (issuer Name = a chain subject);
 *  3. `openssl ts -verify` validates signature + chain against that chain ONLY ("verified").
 * openssl missing → "signature_unverified", never qualified.
 */
export async function assessQualification(token: Buffer, digestHex: string, trust: QualifiedTrust = certignaTrust(), opts: { openssl?: string } = {}): Promise<Qualification> {
  let info: TstInfo;
  try { info = parseTimeStampToken(token); }
  catch (e) {
    return { qualified: false, status: "token_unreadable", policy: null, signer_issuer: null, signature: "not_checked", detail: `Jeton illisible : ${e instanceof Error ? e.message : String(e)}` };
  }
  const issuer = tokenSignerIssuer(token);
  const signer_issuer = issuer ? nameCommonName(issuer) : null;
  const base = { policy: info.policy, signer_issuer };
  if (!info.policy) {
    return { ...base, qualified: false, status: "policy_absent", signature: "not_checked", detail: "OID de politique absent du jeton : non qualifié." };
  }
  if (!trust.policyOids.includes(info.policy)) {
    return { ...base, qualified: false, status: "policy_not_qualified", signature: "not_checked", detail: `OID de politique ${info.policy} : ce n'est pas la politique qualifiée ${trust.name} (${trust.policyOids.join(", ")}).` };
  }
  const chainSubjects = [...pemCertificates(trust.caFile), ...(trust.untrustedFile ? pemCertificates(trust.untrustedFile) : [])]
    .map((d) => { try { return certNames(d).subject; } catch { return null; } })
    .filter((b): b is Buffer => !!b);
  if (!issuer || !chainSubjects.some((s) => s.equals(issuer))) {
    return { ...base, qualified: false, status: "signer_not_trusted", signature: "not_checked", detail: `Certificat signataire non émis par la chaîne ${trust.name} fournie (émetteur : ${signer_issuer ?? "illisible"}).` };
  }
  const sig = await verifyTokenSignature(token, digestHex, trust.caFile, trust.untrustedFile, opts);
  if (sig.status === "unavailable") {
    return { ...base, qualified: false, status: "signature_unverified", signature: sig.status, detail: `Signature non vérifiée (${sig.detail}) : vérification impossible ici, horodatage non déclaré qualifié.` };
  }
  if (sig.status === "failed") {
    return { ...base, qualified: false, status: "signature_invalid", signature: sig.status, detail: `Signature ou chaîne ${trust.name} invalide : ${sig.detail}` };
  }
  return { ...base, qualified: true, status: "qualified", signature: "verified", detail: `Jeton qualifié : OID ${info.policy}, signataire émis par ${signer_issuer ?? trust.name}, signature et chaîne ${trust.name} vérifiées.` };
}
