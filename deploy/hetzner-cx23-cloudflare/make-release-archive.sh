#!/usr/bin/env bash
# Fabrique, EN LOCAL, l'archive à copier sur le VPS (la branche n'est pas forcément sur GitHub).
#   ./make-release-archive.sh [ref=HEAD] [dossier_sortie=./release]
# Contenu : `git archive` du commit (fichiers suivis uniquement : jamais .env.local, node_modules ni dist),
# plus un fichier .release-id (hash court). Refuse un arbre de travail modifié et toute archive contenant un .env.
# Ne pousse rien, ne contacte aucun serveur.
set -Eeuo pipefail
REF="${1:-HEAD}"
OUT="${2:-./release}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "[xvcache] ERREUR : modifications non commitées ; commitez d'abord (l'archive reflète un commit précis)." >&2
  exit 1
fi
ID="$(git rev-parse --short=12 "$REF")"
mkdir -p "$OUT"
FILE="$OUT/xvcache-$ID.tar.gz"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
printf '%s\n' "$ID" >"$TMP/.release-id"
git archive --format=tar --prefix=xvcache/ --add-file="$TMP/.release-id" "$REF" | gzip -9 >"$FILE"
tar -tzf "$FILE" >"$TMP/list"   # liste lue depuis un fichier : pas de SIGPIPE avec pipefail
if awk '/(^|\/)\.env(\.[^\/]*)?$/ && !/\.env\.example$/ {f=1} END {exit !f}' "$TMP/list"; then
  rm -f "$FILE"; echo "[xvcache] ERREUR : un fichier .env serait inclus ; archive supprimée." >&2; exit 1
fi
grep -q '^xvcache/src/remote-server.ts$' "$TMP/list" || { rm -f "$FILE"; echo "[xvcache] ERREUR : src/remote-server.ts absent de $REF." >&2; exit 1; }
( cd "$OUT" && sha256sum "$(basename "$FILE")" >"$(basename "$FILE").sha256" )
echo "[xvcache] archive : $FILE"
echo "[xvcache] empreinte : $(cut -d' ' -f1 "$FILE.sha256")"
