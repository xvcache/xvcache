#!/usr/bin/env bash
# XVcache — installation / mise à jour / retour arrière du serveur MCP distant sur un VPS
# sans Docker (Node.js + systemd). À exécuter SUR LE VPS, en root, par l'opérateur.
#
#   sudo ./install-or-update.sh --check                         # vérifications seules, ne modifie rien
#   sudo ./install-or-update.sh --archive /root/xvcache-<id>.tar.gz [--dry-run]
#   sudo ./install-or-update.sh --git-ref <branche|tag> [--repo URL] [--dry-run]
#   sudo ./install-or-update.sh --rollback [--dry-run]
#   sudo ./install-or-update.sh --tunnel [--dry-run]                # connecteur du tunnel Cloudflare seul
#
# Options : --with-tunnel (installe aussi le connecteur cloudflared par jeton), --with-tests (lance la suite hors ligne avant activation), --keep N (versions gardées, 5),
#           --no-restart (prépare la version sans basculer).
# Idempotent : une version déjà construite (même identifiant) est réutilisée ; le fichier d'environnement
# existant n'est JAMAIS écrasé ni affiché ; l'unité systemd n'est réécrite que si elle a changé.
# Sécurité : n'ouvre aucun port, ne touche ni au DNS ni à la configuration Cloudflare, n'affiche aucun
# secret (seules XVCACHE_REMOTE_PORT / XVCACHE_REMOTE_HOST sont lues dans le fichier de l'application ;
# pour le jeton du tunnel, le script vérifie seulement s'il est renseigné, sans jamais l'afficher).
set -Eeuo pipefail
umask 022

APP_USER="${XVCACHE_APP_USER:-xvcache}"
BASE="${XVCACHE_BASE:-/opt/xvcache}"
ENV_DIR="${XVCACHE_ENV_DIR:-/etc/xvcache}"
ENV_FILE="$ENV_DIR/xvcache-mcp.env"
DATA_DIR="${XVCACHE_DATA_DIR:-/var/lib/xvcache}"
UNIT_NAME="xvcache-mcp.service"
UNIT_PATH="${XVCACHE_UNIT_DIR:-/etc/systemd/system}/$UNIT_NAME"
TUNNEL_UNIT="cloudflared-xvcache.service"
TUNNEL_ENV="${XVCACHE_TUNNEL_ENV:-/etc/cloudflared/xvcache-tunnel.env}"
TUNNEL_PLACEHOLDER="VOTRE_TOKEN_TUNNEL_CLOUDFLARE"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_NODE_MAJOR=20
RECOMMENDED_NODE_MAJOR=26

MODE=""; ARCHIVE=""; GIT_REF=""; REPO="https://github.com/xvcache/xvcache.git"
DRY_RUN=0; WITH_TESTS=0; KEEP=5; NO_RESTART=0; WITH_TUNNEL=0
STAGING=""
AUTO_ROLLBACK=1

log()  { printf '[xvcache] %s\n' "$*"; }
warn() { printf '[xvcache] ATTENTION : %s\n' "$*" >&2; }
die()  { printf '[xvcache] ERREUR : %s\n' "$*" >&2; exit 1; }
run()  { if [[ $DRY_RUN -eq 1 ]]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
cleanup() { if [[ -n "$STAGING" && -d "$STAGING" ]]; then rm -rf -- "$STAGING"; fi; }
trap cleanup EXIT

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check" ;;
    --archive) MODE="archive"; ARCHIVE="${2:-}"; shift ;;
    --git-ref) MODE="git"; GIT_REF="${2:-}"; shift ;;
    --repo) REPO="${2:-}"; shift ;;
    --rollback) MODE="rollback" ;;
    --tunnel) MODE="tunnel" ;;
    --with-tunnel) WITH_TUNNEL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --with-tests) WITH_TESTS=1 ;;
    --keep) KEEP="${2:-}"; shift ;;
    --no-restart) NO_RESTART=1 ;;
    -h|--help) usage 0 ;;
    *) warn "option inconnue : $1"; usage 2 ;;
  esac
  shift
done
[[ -n "$MODE" ]] || usage 2
[[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -ge 2 ]] || die "--keep doit être un entier >= 2"

# ---------------------------------------------------------------- vérifications
env_port() {
  local p=""
  if [[ -r "$ENV_FILE" ]]; then
    p="$(grep -E '^[[:space:]]*XVCACHE_REMOTE_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '[:space:]"'"'" || true)"
  fi
  [[ -z "$p" ]] && p="$(grep -E '^XVCACHE_REMOTE_PORT=' "$HERE/.env.example" | cut -d= -f2)"
  [[ "$p" =~ ^[0-9]+$ && "$p" -ge 1024 && "$p" -le 65535 ]] || die "XVCACHE_REMOTE_PORT invalide : '$p' (1024-65535)"
  printf '%s' "$p"
}

env_host_is_local() {
  [[ -r "$ENV_FILE" ]] || return 0
  local h
  h="$(grep -E '^[[:space:]]*XVCACHE_REMOTE_HOST=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '[:space:]"'"'" || true)"
  [[ -z "$h" || "$h" == "127.0.0.1" || "$h" == "::1" || "$h" == "localhost" ]]
}

preflight() {
  local ok=1
  log "Vérifications préalables"
  if [[ $EUID -ne 0 ]]; then
    if [[ $DRY_RUN -eq 1 || "$MODE" == "check" ]]; then warn "pas root : simple simulation/vérification"; else die "à lancer en root (sudo)"; fi
  fi
  command -v systemctl >/dev/null || { warn "systemctl introuvable (systemd requis)"; ok=0; }
  for c in tar curl openssl sha256sum; do command -v "$c" >/dev/null || { warn "$c introuvable"; ok=0; }; done
  [[ "$MODE" == "git" ]] && { command -v git >/dev/null || { warn "git introuvable"; ok=0; }; }
  if command -v node >/dev/null && command -v npm >/dev/null; then
    local major; major="$(node -p 'process.versions.node.split(".")[0]')"
    if (( major < MIN_NODE_MAJOR )); then warn "Node $major trop ancien (>= $MIN_NODE_MAJOR requis, $RECOMMENDED_NODE_MAJOR LTS recommandé)"; ok=0
    elif (( major < RECOMMENDED_NODE_MAJOR )); then warn "Node $major accepté ; Node $RECOMMENDED_NODE_MAJOR LTS recommandé"; fi
    log "node $(node -v) ($(command -v node)), npm $(npm -v)"
  else
    warn "node/npm introuvables : installer Node $RECOMMENDED_NODE_MAJOR LTS"; ok=0
  fi
  local port; port="$(env_port)"
  env_host_is_local || { warn "XVCACHE_REMOTE_HOST n'est pas local dans $ENV_FILE : refusé (le tunnel doit être le seul accès)"; ok=0; }
  if command -v ss >/dev/null; then
    local holder ours
    holder="$(ss -Hltnp "sport = :$port" 2>/dev/null || true)"
    ours="$(systemctl show -p MainPID --value "$UNIT_NAME" 2>/dev/null || echo 0)"
    if [[ -n "$holder" ]] && ! { [[ "${ours:-0}" != "0" ]] && grep -q "pid=$ours," <<<"$holder"; }; then
      warn "le port $port est déjà utilisé par un autre programme : $holder"; ok=0
    fi
    if ss -Hltn 2>/dev/null | awk '$4 ~ /^(0\.0\.0\.0|\*|\[::\]):(80|443)$/ {f=1} END {exit !f}'; then
      warn "un service écoute publiquement sur 80/443 : inutile avec le tunnel, à vérifier"
    fi
  fi
  [[ -f "$HERE/xvcache-mcp.service" && -f "$HERE/.env.example" ]] || { warn "modèles absents à côté du script"; ok=0; }
  [[ $ok -eq 1 ]] || die "vérifications en échec (voir ci-dessus)"
  log "Vérifications OK (port local $port)"
}

# ---------------------------------------------------------------- étapes
ensure_user_and_dirs() {
  if id -u "$APP_USER" >/dev/null 2>&1; then log "utilisateur $APP_USER présent"
  else run useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"; fi
  run install -d -o root -g root -m 0755 "$BASE" "$BASE/releases"
  run install -d -o root -g "$APP_USER" -m 0750 "$ENV_DIR"
  # /var/lib/xvcache est créé par systemd (StateDirectory) ; on le crée aussi pour les sauvegardes.
  run install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$DATA_DIR"
}

ensure_env_file() {
  if [[ -e "$ENV_FILE" ]]; then
    log "fichier d'environnement existant conservé ($ENV_FILE, contenu non lu)"
  else
    run install -o root -g "$APP_USER" -m 0640 "$HERE/.env.example" "$ENV_FILE"
    log "modèle copié vers $ENV_FILE (mode TEST FreeTSA, sans secret) ; à relire avant mise en service publique"
  fi
}

release_id_from_dir() {
  local d="$1"
  if [[ -f "$d/.release-id" ]]; then tr -cd 'A-Za-z0-9._-' <"$d/.release-id" | cut -c1-40
  elif [[ -d "$d/.git" ]]; then git -C "$d" rev-parse --short=12 HEAD
  else return 1; fi
}

fetch_source() {
  STAGING="$(mktemp -d "$BASE/releases/.staging.XXXXXX" 2>/dev/null || mktemp -d)"
  if [[ "$MODE" == "archive" ]]; then
    [[ -f "$ARCHIVE" ]] || die "archive introuvable : $ARCHIVE"
    tar -tzf "$ARCHIVE" >"$STAGING/.list"   # lu depuis un fichier : pas de SIGPIPE avec pipefail
    if awk '/(^|\/)\.env(\.[^\/]*)?$/ && !/\.env\.example$/ {f=1} END {exit !f}' "$STAGING/.list"; then
      die "l'archive contient un fichier .env : refusée (aucun secret ne doit voyager dans l'archive)"
    fi
    rm -f "$STAGING/.list"
    tar -xzf "$ARCHIVE" -C "$STAGING" --no-same-owner --strip-components=1
    [[ -f "$STAGING/.release-id" ]] || sha256sum "$ARCHIVE" | cut -c1-12 >"$STAGING/.release-id"
  else
    [[ -n "$GIT_REF" ]] || die "--git-ref vide"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$GIT_REF" "$REPO" "$STAGING/src"
    git -C "$STAGING/src" rev-parse --short=12 HEAD >"$STAGING/src/.release-id"
    rm -rf "$STAGING/src/.git"
    shopt -s dotglob; mv "$STAGING/src/"* "$STAGING/"; shopt -u dotglob; rmdir "$STAGING/src"
  fi
  [[ -f "$STAGING/package.json" && -f "$STAGING/src/remote-server.ts" ]] || die "la source ne contient pas le serveur distant (src/remote-server.ts) : mauvaise version ?"
}

build_release() {
  local id dest
  id="$(release_id_from_dir "$STAGING")" || die "identifiant de version introuvable"
  dest="$BASE/releases/$id"
  if [[ -f "$dest/dist/remote-server.js" ]]; then
    log "version $id déjà construite : réutilisée"
  else
    log "construction de la version $id"
    if [[ $DRY_RUN -eq 1 ]]; then
      printf '[dry-run] (cd %s && npm ci --ignore-scripts --no-audit --no-fund && npm run build%s && npm prune --omit=dev)\n' "$STAGING" "$([[ $WITH_TESTS -eq 1 ]] && echo ' && XVCACHE_OFFLINE=1 npm test')"
      printf '[dry-run] mv %s %s\n' "$STAGING" "$dest"
    else
      (
        cd "$STAGING"
        export npm_config_cache="$BASE/.npm-cache" npm_config_update_notifier=false
        npm ci --ignore-scripts --no-audit --no-fund
        npm run build
        if [[ $WITH_TESTS -eq 1 ]]; then XVCACHE_OFFLINE=1 XVCACHE_TSA_PROVIDER=freetsa npm test; fi
        npm prune --omit=dev --ignore-scripts --no-audit --no-fund
      )
      [[ -f "$STAGING/dist/remote-server.js" ]] || die "build incomplet : dist/remote-server.js absent"
      chown -R root:root "$STAGING"
      chmod -R go-w "$STAGING"
      chmod 0755 "$STAGING"
      mv -T "$STAGING" "$dest"
      STAGING=""
    fi
  fi
  RELEASE_ID="$id"
}

install_unit() {
  local node_bin tmp
  node_bin="$(command -v node || echo /usr/local/bin/node)"
  tmp="$(mktemp)"
  sed "s#@NODE_BIN@#$node_bin#g" "$HERE/xvcache-mcp.service" >"$tmp"
  if [[ -f "$UNIT_PATH" ]] && cmp -s "$tmp" "$UNIT_PATH"; then
    log "unité systemd inchangée"
  else
    run install -o root -g root -m 0644 "$tmp" "$UNIT_PATH"
    run systemctl daemon-reload
    if command -v systemd-analyze >/dev/null && [[ $DRY_RUN -eq 0 ]]; then systemd-analyze verify "$UNIT_PATH" || warn "systemd-analyze verify signale des avertissements"; fi
  fi
  rm -f "$tmp"
  run systemctl enable "$UNIT_NAME" >/dev/null
  # Sauvegarde quotidienne (idempotent)
  local u changed=0 unit_dir
  unit_dir="$(dirname "$UNIT_PATH")"
  for u in xvcache-backup.service xvcache-backup.timer; do
    if ! cmp -s "$HERE/$u" "$unit_dir/$u" 2>/dev/null; then run install -o root -g root -m 0644 "$HERE/$u" "$unit_dir/$u"; changed=1; fi
  done
  [[ $changed -eq 1 ]] && run systemctl daemon-reload
  run systemctl enable --now xvcache-backup.timer >/dev/null
}

switch_to() {
  local id="$1" cur=""
  [[ -L "$BASE/current" ]] && cur="$(basename "$(readlink "$BASE/current")")"
  if [[ "$cur" == "$id" ]]; then log "version active déjà $id"; return 0; fi
  [[ -n "$cur" ]] && run sh -c "printf '%s\n' '$cur' > '$BASE/previous'"
  run ln -sfn "releases/$id" "$BASE/current.new"
  run mv -T "$BASE/current.new" "$BASE/current"
  log "version active : $id (précédente : ${cur:-aucune})"
}

health_check() {
  local port="$1" body
  [[ $DRY_RUN -eq 1 ]] && { log "[dry-run] contrôle santé http://127.0.0.1:$port/healthz + tools/list"; return 0; }
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      body="$(curl -fsS --max-time 10 -X POST "http://127.0.0.1:$port/mcp" \
        -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' || true)"
      if grep -q '"certify_document"' <<<"$body" && grep -q '"verify_document"' <<<"$body"; then
        log "santé OK : /healthz répond et tools/list expose certify_document / verify_document"
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

restart_and_verify() {
  local port; port="$(env_port)"
  run systemctl restart "$UNIT_NAME"
  if ! health_check "$port"; then
    warn "le service ne répond pas correctement après redémarrage"
    if [[ $AUTO_ROLLBACK -eq 1 && -f "$BASE/previous" ]]; then
      local prev; prev="$(cat "$BASE/previous")"
      warn "retour arrière automatique vers $prev"
      run ln -sfn "releases/$prev" "$BASE/current.new"
      run mv -T "$BASE/current.new" "$BASE/current"
      run systemctl restart "$UNIT_NAME"
      health_check "$port" && warn "retour arrière effectué ; la nouvelle version reste dans releases/ pour analyse"
    fi
    journalctl -u "$UNIT_NAME" -n 30 --no-pager 2>/dev/null | grep -viE 'password|authorization|xvc_' || true
    die "déploiement en échec"
  fi
}

prune_releases() {
  local cur prev
  cur="$(basename "$(readlink "$BASE/current" 2>/dev/null || echo none)")"
  prev="$(cat "$BASE/previous" 2>/dev/null || echo none)"
  # Versions triées de la plus récente à la plus ancienne (noms = hash court, sans espace)
  mapfile -t all < <(find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.staging.*' -printf '%T@ %f\n' 2>/dev/null | sort -rn | cut -d' ' -f2)
  local n=0
  for r in "${all[@]}"; do
    n=$((n + 1))
    if (( n > KEEP )) && [[ "$r" != "$cur" && "$r" != "$prev" ]]; then run rm -rf -- "$BASE/releases/$r"; fi
  done
}

# ---------------------------------------------------------------- tunnel Cloudflare (mode jeton)
# État du jeton SANS l'afficher : placeholder | set | empty | absent | unreadable
tunnel_token_state() {
  [[ -e "$TUNNEL_ENV" ]] || { echo absent; return; }
  [[ -r "$TUNNEL_ENV" ]] || { echo unreadable; return; }
  if grep -q "$TUNNEL_PLACEHOLDER" "$TUNNEL_ENV"; then echo placeholder
  elif grep -Eq '^[[:space:]]*CLOUDFLARE_TUNNEL_TOKEN=[^[:space:]]+' "$TUNNEL_ENV"; then echo set
  else echo empty; fi
}

tunnel_status() {
  log "Tunnel Cloudflare (mode jeton)"
  if command -v cloudflared >/dev/null; then log "cloudflared : $(cloudflared --version 2>/dev/null | head -n1)"; else warn "cloudflared non installé"; fi
  if [[ -e "$TUNNEL_ENV" ]]; then
    log "fichier du jeton : $TUNNEL_ENV ($(stat -c '%U:%G %a' "$TUNNEL_ENV"), jeton : $(tunnel_token_state))"
    [[ "$(stat -c '%a' "$TUNNEL_ENV")" == "600" ]] || warn "droits de $TUNNEL_ENV différents de 600"
  else
    log "fichier du jeton absent ($TUNNEL_ENV)"
  fi
  log "service $TUNNEL_UNIT : $(systemctl is-active "$TUNNEL_UNIT" 2>/dev/null || true)"
  if systemctl is-enabled cloudflared.service >/dev/null 2>&1; then
    warn "cloudflared.service (créé par 'cloudflared service install <TOKEN>') est aussi actif : garder un seul connecteur"
  fi
}

setup_tunnel() {
  local unit_dir changed=0 state tmp
  unit_dir="$(dirname "$UNIT_PATH")"
  command -v cloudflared >/dev/null || die "cloudflared absent : l'installer d'abord"
  [[ -x /usr/bin/cloudflared ]] || warn "cloudflared n'est pas dans /usr/bin : adapter ExecStart de $TUNNEL_UNIT"
  run install -d -o root -g root -m 0755 "$(dirname "$TUNNEL_ENV")"
  if [[ -e "$TUNNEL_ENV" ]]; then
    log "fichier du jeton existant conservé ($TUNNEL_ENV, contenu non affiché) ; droits forcés à root:root 0600"
    run chown root:root "$TUNNEL_ENV"
    run chmod 0600 "$TUNNEL_ENV"
  else
    run install -o root -g root -m 0600 "$HERE/cloudflared-tunnel.env.example" "$TUNNEL_ENV"
    log "modèle copié vers $TUNNEL_ENV (0600) : y coller le jeton du tunnel à la place de $TUNNEL_PLACEHOLDER"
  fi
  tmp="$HERE/$TUNNEL_UNIT"
  if ! cmp -s "$tmp" "$unit_dir/$TUNNEL_UNIT" 2>/dev/null; then
    run install -o root -g root -m 0644 "$tmp" "$unit_dir/$TUNNEL_UNIT"; changed=1
    run systemctl daemon-reload
  fi
  state="$(tunnel_token_state)"
  if [[ $DRY_RUN -eq 1 && "$state" == "absent" ]]; then state="placeholder"; fi
  if [[ "$state" != "set" ]]; then
    warn "jeton du tunnel non renseigné ($state) : $TUNNEL_UNIT installé mais NON démarré."
    warn "Coller le jeton dans $TUNNEL_ENV (sudoedit), puis relancer : sudo $0 --tunnel"
    return 0
  fi
  if systemctl is-enabled cloudflared.service >/dev/null 2>&1; then
    warn "cloudflared.service existe déjà (installé par 'cloudflared service install') : deux connecteurs pour le même tunnel. En garder un seul."
  fi
  run systemctl enable "$TUNNEL_UNIT" >/dev/null
  if [[ $changed -eq 1 ]] || ! systemctl is-active --quiet "$TUNNEL_UNIT" 2>/dev/null; then run systemctl restart "$TUNNEL_UNIT"; fi
  if [[ $DRY_RUN -eq 0 ]]; then
    sleep 3
    systemctl is-active --quiet "$TUNNEL_UNIT" || { journalctl -u "$TUNNEL_UNIT" -n 20 --no-pager 2>/dev/null | grep -viE 'token|eyJ' || true; die "le connecteur du tunnel ne démarre pas"; }
    log "tunnel actif : vérifier https://mcp.xvcache.com/healthz (check-health.sh https://mcp.xvcache.com)"
  fi
}

# ---------------------------------------------------------------- main
preflight
case "$MODE" in
  check)
    log "mode --check : aucune modification effectuée"
    if [[ -L "$BASE/current" ]]; then log "version active : $(basename "$(readlink "$BASE/current")")"; else log "aucune version installée"; fi
    tunnel_status
    ;;
  tunnel)
    setup_tunnel
    ;;
  archive|git)
    ensure_user_and_dirs
    ensure_env_file
    if [[ $DRY_RUN -eq 1 && ! -d "$BASE/releases" ]]; then
      log "[dry-run] $BASE/releases n'existe pas encore : extraction simulée dans un dossier temporaire"
    fi
    fetch_source
    build_release
    install_unit
    if [[ $NO_RESTART -eq 1 ]]; then log "--no-restart : version $RELEASE_ID prête, non activée"; exit 0; fi
    switch_to "$RELEASE_ID"
    restart_and_verify
    prune_releases
    if [[ $WITH_TUNNEL -eq 1 ]]; then setup_tunnel; fi
    log "terminé : version $RELEASE_ID active sur 127.0.0.1:$(env_port) (publication via le tunnel cloudflared)"
    ;;
  rollback)
    [[ -f "$BASE/previous" ]] || die "aucune version précédente enregistrée ($BASE/previous)"
    prev="$(cat "$BASE/previous")"
    AUTO_ROLLBACK=0
    [[ -f "$BASE/releases/$prev/dist/remote-server.js" ]] || die "version précédente $prev absente ou incomplète"
    switch_to "$prev"
    restart_and_verify
    log "retour arrière terminé : version $prev active"
    ;;
esac
