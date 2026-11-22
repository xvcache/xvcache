#!/usr/bin/env bash
# Sauvegarde des données XVcache (preuves, lots, jetons, abonnements hachés) + purge des PDF expirés.
#   sudo ./backup.sh [dossier=/var/backups/xvcache] [jours_de_rétention=30]
# Les PDF temporaires (liens 24 h) ne sont pas sauvegardés. Le fichier d'environnement
# (/etc/xvcache/xvcache-mcp.env) n'est PAS inclus : il peut contenir un secret Certigna,
# à conserver dans le gestionnaire de mots de passe. Copier ensuite les archives HORS du VPS.
set -Eeuo pipefail
umask 077
DATA="${XVCACHE_DATA_DIR:-/var/lib/xvcache}"
DEST="${1:-/var/backups/xvcache}"
DAYS="${2:-30}"
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "rétention invalide" >&2; exit 2; }
[[ -d "$DATA" ]] || { echo "[xvcache] rien à sauvegarder : $DATA absent" >&2; exit 0; }
install -d -m 0700 "$DEST"
if [[ -d "$DATA/hosted/pdf" ]]; then
  find "$DATA/hosted/pdf" -type f \( -name '*.pdf' -o -name '*.json' \) -mmin +1500 -delete
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/xvcache-data-$STAMP.tar.gz"
tar -czf "$OUT.part" -C "$(dirname "$DATA")" --exclude="$(basename "$DATA")/hosted/pdf" "$(basename "$DATA")"
mv "$OUT.part" "$OUT"
sha256sum "$OUT" >"$OUT.sha256"
find "$DEST" -maxdepth 1 -type f -name 'xvcache-data-*.tar.gz*' -mtime +"$DAYS" -delete
echo "[xvcache] sauvegarde : $OUT ($(du -h "$OUT" | cut -f1))"
