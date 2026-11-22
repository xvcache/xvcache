#!/usr/bin/env bash
# Vérifie un serveur XVcache distant : santé, liste des outils, get_offer sans clé,
# certify_document sans clé => PAYMENT_REQUIRED, empreinte invalide refusée. Lecture seule : aucune
# certification n'est faite, aucun jeton TSA consommé, aucune clé utilisée.
#   ./check-health.sh                          # local sur le VPS (http://127.0.0.1:8787)
#   ./check-health.sh https://mcp.xvcache.com  # via le tunnel Cloudflare
set -Eeuo pipefail
BASE="${1:-http://127.0.0.1:8787}"; BASE="${BASE%/}"
fail=0
ok()  { printf '  OK   %s\n' "$*"; }
ko()  { printf '  ÉCHEC %s\n' "$*"; fail=1; }
rpc() {
  curl -fsS --max-time 20 -X POST "$BASE/mcp" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -d "$1"
}
echo "Contrôle de $BASE"
if h="$(curl -fsS --max-time 10 "$BASE/healthz")" && grep -q '"ok":true' <<<"$h"; then ok "/healthz : $h"; else ko "/healthz ne répond pas"; fi
t="$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' || true)"
for n in get_offer present_to_client request_upgrade get_subscription certify_document certify_hash verify_document get_certificate_pdf; do
  if grep -q "\"$n\"" <<<"$t"; then ok "outil $n présent"; else ko "outil $n absent"; fi
done
o="$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_offer","arguments":{"lang":"fr"}}}' || true)"
if grep -q 'present_to_client' <<<"$o"; then ok "get_offer sans clé"; else ko "get_offer sans clé"; fi
p="$(rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"certify_document","arguments":{"sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}}' || true)"
if grep -q 'PAYMENT_REQUIRED' <<<"$p"; then ok "certify_document sans clé => PAYMENT_REQUIRED"; else ko "certify_document sans clé devrait renvoyer PAYMENT_REQUIRED"; fi
v="$(rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"verify_document","arguments":{"sha256":"texte du document","proof_id":"xvh_x"}}}' || true)"
if grep -q 'HASH_INVALID' <<<"$v"; then ok "contenu non haché refusé (HASH_INVALID)"; else ko "HASH_INVALID attendu"; fi
# /pdf/*.pdf atteint bien le serveur : un jeton inconnu donne 404 (et jamais une page HTML de défi)
pdf="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 10 "$BASE/pdf/jetonInconnu000000000000.pdf" || true)"
if [[ "${pdf%% *}" == "404" && "$pdf" != *text/html* ]]; then ok "route /pdf/*.pdf joignable (jeton inconnu => 404)"; else ko "route /pdf/*.pdf : $pdf (404 attendu)"; fi
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/nimporte-quoi" || true)"
if [[ "$code" == "404" ]]; then ok "route inconnue => 404"; else ko "route inconnue => $code (404 attendu)"; fi
if [[ $fail -eq 0 ]]; then echo "Tout est OK."; else echo "Au moins un contrôle a échoué."; exit 1; fi
