/**
 * Local-only demo for lawyers: drop a document, get a green Intact + PDF
 * or a red "Modifié depuis le …". Binds to 127.0.0.1 only. Never Docker.
 * Does not stamp (and therefore does not spend a Certigna token) unless
 * XVCACHE_DEMO_STAMP=1 is set.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Certifier } from "./certify.js";
import { handleDocument, type DocumentResult } from "./certificate.js";

export type DemoOptions = {
  certifier: Certifier;
  host?: string;
  port?: number;
  stamp?: boolean;
};

const MAX_UPLOAD = 16 * 1024 * 1024;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function page(result: DocumentResult | null, notice?: string): string {
  const v = result?.verdict;
  const kind = v?.kind ?? "";
  const has = Boolean(result && result.ok && v);
  const title = has ? v!.title : "XVcache";
  let resultHtml = "";
  if (notice && !has) {
    resultHtml = `<div class="card result miss"><p class="sentence">${escapeHtml(notice)}</p></div>`;
  } else if (has && kind === "intact") {
    const pdfLink = result!.pdf
      ? `<a class="btn" href="/certificat?batch=${encodeURIComponent(result!.batch_id ?? "")}&amp;path=${encodeURIComponent(result!.path ?? "")}">Télécharger le certificat PDF</a>`
      : "";
    resultHtml = `<div class="card result ok">
      <div class="badge v">V</div>
      <h2>Intact</h2>
      <p class="sentence">${escapeHtml(v!.sentence)}</p>
      ${result!.qualified ? `<p class="meta">Prestataire : Certigna — horodatage électronique qualifié eIDAS</p>` : `<p class="meta warn">Ce jeton n'est pas un horodatage qualifié eIDAS.</p>`}
      ${pdfLink}
    </div>`;
  } else if (has && kind === "modifie") {
    resultHtml = `<div class="card result ko">
      <div class="badge x">X</div>
      <h2>Modifié</h2>
      <p class="sentence">${escapeHtml(v!.sentence)}</p>
    </div>`;
  } else if (has && kind === "invalide") {
    resultHtml = `<div class="card result ko">
      <div class="badge x">X</div>
      <h2>Preuve invalide</h2>
      <p class="sentence">${escapeHtml(v!.sentence)}</p>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — XVcache</title>
  <style>
    :root { --ink:#1b1b18; --muted:#5c5a55; --paper:#f6f4ef; --card:#fff; --line:#ddd9d1; --green:#0f7a4a; --green-soft:#e8f6ef; --red:#b42318; --red-soft:#fdecea; --warn:#8a5a10; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; background:var(--paper); color:var(--ink);
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
    header { padding: 28px 24px 0; max-width: 640px; margin: 0 auto; }
    header .brand { font-family: Georgia, "Times New Roman", serif; font-size: 15px; letter-spacing: .04em; }
    header p { color: var(--muted); font-size: 14px; margin: 6px 0 0; }
    main { max-width: 640px; margin: 0 auto; padding: 28px 24px 64px; }
    .drop { background: var(--card); border: 1.5px dashed var(--line); border-radius: 16px; padding: 48px 28px;
      text-align: center; cursor: pointer; transition: border-color .15s, background .15s; }
    .drop:hover, .drop.over { border-color: var(--ink); background: #fffcf7; }
    .drop h1 { font-family: Georgia, "Times New Roman", serif; font-weight: normal; font-size: 28px; margin: 0 0 8px; }
    .drop p { margin: 0; color: var(--muted); font-size: 15px; }
    .drop input { display: none; }
    .card.result { margin-top: 24px; background: var(--card); border-radius: 16px; padding: 28px 28px 32px;
      border: 1px solid var(--line); }
    .card.result.ok { border-color: #b7dcc8; background: linear-gradient(180deg, var(--green-soft), var(--card) 42%); }
    .card.result.ko { border-color: #f0c2bd; background: linear-gradient(180deg, var(--red-soft), var(--card) 42%); }
    .badge { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      font-family: Georgia, serif; font-size: 18px; color: #fff; margin-bottom: 14px; }
    .badge.v { background: var(--green); }
    .badge.x { background: var(--red); }
    .card.result h2 { font-family: Georgia, "Times New Roman", serif; font-weight: normal; font-size: 32px; margin: 0 0 8px; }
    .sentence { font-size: 17px; line-height: 1.45; margin: 0 0 16px; }
    .meta { font-size: 13px; color: var(--muted); margin: 0 0 20px; }
    .meta.warn { color: var(--warn); }
    .btn { display: inline-block; background: var(--ink); color: #fff; text-decoration: none; padding: 12px 18px;
      border-radius: 8px; font-size: 14px; }
    .btn:hover { opacity: .9; }
    .again { display: inline-block; margin-top: 18px; color: var(--muted); font-size: 13px; }
    footer { max-width: 640px; margin: 0 auto; padding: 0 24px 40px; color: var(--muted); font-size: 12px; line-height: 1.5; }
  </style>
</head>
<body>
  <header>
    <div class="brand">XVcache</div>
    <p>Déposez un document. Vous obtenez une coche verte et un certificat, ou la date de la modification.</p>
  </header>
  <main>
    <form class="drop" id="drop" action="/verifier" method="post" enctype="multipart/form-data">
      <h1>Glissez votre document ici</h1>
      <p>ou cliquez pour le choisir — la note ne quitte pas cette machine</p>
      <input type="file" name="fichier" id="fichier">
    </form>
    ${resultHtml}
    ${has ? `<a class="again" href="/">Vérifier un autre document</a>` : ""}
  </main>
  <footer>
    Ce service n'est pas un constat d'huissier, ni une signature électronique qualifiée, ni un conseil juridique.
    La page n'écoute que sur cet ordinateur (127.0.0.1).
  </footer>
  <script>
    const drop = document.getElementById("drop");
    const input = document.getElementById("fichier");
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); drop.classList.remove("over");
      if (e.dataTransfer.files[0]) { input.files = e.dataTransfer.files; drop.submit(); }
    });
    input.addEventListener("change", () => { if (input.files[0]) drop.submit(); });
  </script>
</body>
</html>`;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        req.destroy();
        reject(new Error("Fichier trop volumineux."));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buf: Buffer, contentType: string): { filename: string; bytes: Buffer } | null {
  const m = /boundary=([^;]+)/i.exec(contentType);
  if (!m) return null;
  const boundary = Buffer.from("--" + m[1].trim().replace(/^"|"$/g, ""));
  let start = buf.indexOf(boundary);
  if (start < 0) return null;
  start += boundary.length;
  if (buf[start] === 13) start += 2;
  const headerEnd = buf.indexOf("\r\n\r\n", start);
  if (headerEnd < 0) return null;
  const headers = buf.subarray(start, headerEnd).toString("utf8");
  const name = /filename="([^"]*)"/i.exec(headers);
  const filename = name ? name[1] : "document";
  const bodyStart = headerEnd + 4;
  const end = buf.indexOf(Buffer.concat([Buffer.from("\r\n"), boundary]), bodyStart);
  const bytes = buf.subarray(bodyStart, end < 0 ? buf.length : end);
  return { filename: path.basename(filename.replace(/\\/g, "/")), bytes };
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(body);
}

function safePair(url: URL): { batch: string; rel: string } | null {
  const batch = url.searchParams.get("batch") ?? "";
  const rel = url.searchParams.get("path") ?? "";
  if (!batch || !rel) return null;
  if (batch.includes("..") || rel.includes("..") || path.isAbsolute(rel) || batch.includes("/") || batch.includes("\\")) return null;
  return { batch, rel };
}

export function startDemoServer(opts: DemoOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    return Promise.reject(new Error("La démo n'écoute que sur 127.0.0.1."));
  }
  const port = opts.port ?? 8765;
  const stamp = opts.stamp === true;
  const certifier = opts.certifier;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const fichier = url.searchParams.get("fichier");
        if (fichier) {
          const result = await handleDocument(certifier, { path: fichier, stamp, online: false });
          const notice = result.ok ? undefined : (result.error ?? "Document inconnu.");
          send(res, 200, page(result.ok ? result : null, notice), "text/html; charset=utf-8");
          return;
        }
        send(res, 200, page(null), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "POST" && url.pathname === "/verifier") {
        const body = await readBody(req, MAX_UPLOAD);
        const part = parseMultipart(body, req.headers["content-type"] ?? "");
        if (!part || part.bytes.length === 0) {
          send(res, 400, page(null, "Aucun fichier reçu."), "text/html; charset=utf-8");
          return;
        }
        const result = await handleDocument(certifier, {
          filename: part.filename,
          content: part.bytes,
          stamp: false,
          online: false,
        });
        const notice = result.ok ? undefined : (result.error ?? "Document inconnu.");
        send(res, 200, page(result.ok ? result : null, notice), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/certificat") {
        const pair = safePair(url);
        if (!pair) { send(res, 400, "Requête invalide.", "text/plain; charset=utf-8"); return; }
        const pdf = path.join(certifier.cfg.dataDir, "certificates", ...pair.rel.split("/"), pair.batch, "certificat.pdf");
        const root = path.join(certifier.cfg.dataDir, "certificates") + path.sep;
        if (!pdf.startsWith(root)) { send(res, 400, "Requête invalide.", "text/plain; charset=utf-8"); return; }
        try {
          const bytes = await fs.readFile(pdf);
          const name = `XVcache-certificat-${path.basename(pair.rel)}.pdf`;
          send(res, 200, bytes, "application/pdf", { "Content-Disposition": `attachment; filename="${name}"` });
        } catch {
          send(res, 404, "Certificat introuvable.", "text/plain; charset=utf-8");
        }
        return;
      }
      send(res, 404, "Introuvable.", "text/plain; charset=utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      send(res, 500, page(null, msg), "text/html; charset=utf-8");
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      resolve({
        url: `http://${host}:${(server.address() as { port: number }).port}/`,
        close: () => new Promise((r, j) => server.close((err) => err ? j(err) : r())),
      });
    });
  });
}
