# Déployer le serveur MCP distant XVcache sur le VPS Hetzner CX23 (Nuremberg), derrière un tunnel Cloudflare

> **Statut : documentation préparée en local, rien n'a été exécuté sur le VPS, ni sur le DNS, ni chez Cloudflare.**
> Le tunnel `xvcache-mcp` (géré à distance) et sa route `mcp.xvcache.com` → `127.0.0.1:8787` existent déjà (§ 7). Il ne reste qu'à installer l'application et le connecteur sur le VPS.
> Chaque étape marquée ⚠️ change quelque chose à l'extérieur (VPS, DNS, Cloudflare, coût). Ne la lancer qu'avec l'accord de Julien.

| Élément | Valeur |
|---|---|
| Serveur | Hetzner Cloud CX23, Nuremberg, `91.98.229.110` |
| Pare-feu Hetzner | `jaycache-ssh-only` (entrée : SSH uniquement), **inchangé** |
| Conteneurs | aucun (pas de Docker) : Node.js + systemd |
| Exposition publique | uniquement par le tunnel Cloudflare `xvcache-mcp` (géré à distance, par jeton, connexions **sortantes**), aucun port 80/443 ouvert |
| Routes publiées | `mcp.xvcache.com` → `http://127.0.0.1:8787` : `/mcp`, `/healthz`, `/pdf/*.pdf` |
| Nom public visé | `https://mcp.xvcache.com/mcp` |
| Écoute locale | `127.0.0.1:8787` (modifiable via `XVCACHE_REMOTE_PORT`) |
| Programme lancé | `dist/remote-server.js` (bin `xvcache-remote`) : outils MCP sur `/mcp`, santé sur `/healthz`, PDF temporaires sur `/pdf/<jeton>.pdf` |

## 0. Ce qui est déployé, et ce qui ne l'est pas

- **Déployé** : le serveur MCP distant « empreinte seule » des lots L1 à L3.
  - Il ne reçoit que des SHA-256, jamais de document.
  - Outils : get_offer, present_to_client, request_upgrade, get_subscription, certify_document, certify_hash, verify_document, get_certificate_pdf, get_usage.
  - Certificats PDF dans les 24 langues de l'UE.
- **Pas de paiement** : Stripe arrive avec le lot L4. D'ici là, `request_upgrade` répond `BILLING_UNAVAILABLE` (rien n'est facturé). Les clés API se créent à la main par l'opérateur (§ 6).
- **Horodatage par défaut : FreeTSA**. Gratuit, mais **non qualifié** : chaque PDF porte le bandeau « NON QUALIFIÉ ». Le passage à Certigna (qualifié eIDAS, **payant au jeton**) est une décision de Julien (§ 5.2).
- **Pas déployé** : le serveur de test ChatGPT d'Horizon (`src/live-server.ts`), qui est un autre programme.
- **Hors périmètre** de ce dossier : le site xvcache.com, les CGV, le RGPD (L7) et la publication npm / registre MCP (L5).

## 1. Prérequis

1. **Accès** : Julien (ou une personne qu'il désigne) se connecte en SSH au VPS avec sa propre clé et a les droits `sudo`. Aucun agent ne se connecte au VPS.
2. **Système** : Ubuntu 24.04 LTS ou Debian 12/13, architecture x86_64 (la gamme CX est en x86). À confirmer avec `cat /etc/os-release && uname -m`.
3. **Pare-feu Hetzner `jaycache-ssh-only`** :
   - Entrant : seul SSH (22/tcp). On n'ajoute **rien**.
   - Sortant : le VPS doit pouvoir joindre l'extérieur. Si le pare-feu n'a **aucune règle sortante**, Hetzner laisse tout sortir. Sinon, il faut au minimum :
     - 443/tcp : Node.js, npm, FreeTSA / Certigna, calendriers OpenTimestamps, API Cloudflare ;
     - 7844/tcp **et** 7844/udp : connexions du tunnel `cloudflared` (QUIC, avec repli en HTTP/2).
   - À vérifier dans la console Hetzner (Firewalls → `jaycache-ssh-only` → Outbound).
4. **Domaine et tunnel** : la zone `xvcache.com` est sur Cloudflare. Le tunnel `xvcache-mcp` et sa route `mcp.xvcache.com` existent déjà. Il faut le **jeton** du tunnel (tableau de bord Cloudflare, § 7.2).
5. **Poste local** (celui de l'opérateur) : `git`, `bash`, `tar`, `gzip`, `sha256sum`, et une copie du dépôt sur la branche à déployer.
6. **Paquets sur le VPS** (étape ⚠️, elle modifie le VPS) :
   ```bash
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl openssl tar xz-utils libatomic1
   ```
   - `openssl` sert à vérifier les signatures des jetons RFC 3161.
   - `libatomic1` est requis par les binaires officiels de Node 25 et plus.

## 2. Installer Node.js 26 LTS (sans Docker, binaire officiel vérifié) ⚠️

Node 26 « Lithium » est la LTS active depuis le 28/10/2026. Le projet accepte Node ≥ 20.

```bash
NODE_VERSION=v26.13.1   # dernière 26.x au 22/11/2026 (correctif de sécurité du 11/11/2026) ; vérifier sur https://nodejs.org/dist/latest-v26.x/
cd /tmp
curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
grep " node-${NODE_VERSION}-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -   # doit afficher : OK
sudo tar -xJf "node-${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 --no-same-owner
node -v && npm -v    # v26.x et npm 11.x
```

Le script d'installation repère `node` tout seul (`command -v node`, normalement `/usr/local/bin/node`) et écrit ce chemin dans l'unité systemd.

## 3. Préparer l'archive de la version (sur le poste local)

La branche peut ne pas exister sur GitHub, car rien n'est poussé. On déploie donc une **archive d'un commit précis**, fabriquée en local :

```bash
cd /chemin/vers/xvcache        # copie locale du dépôt, branche à déployer
git status                      # doit être propre
deploy/hetzner-cx23-cloudflare/make-release-archive.sh HEAD ./release
# → release/xvcache-<id>.tar.gz  +  release/xvcache-<id>.tar.gz.sha256
```

- L'archive vient de `git archive` : seuls les fichiers suivis par git y sont.
- Elle ne contient **jamais** `.env.local`, `node_modules` ni `dist`.
- Le script refuse l'archive si un `.env` s'y trouve. Il ajoute un fichier `.release-id` (le hash court du commit).

Envoi vers le VPS (⚠️, par Julien, avec sa clé SSH) :

```bash
scp release/xvcache-<id>.tar.gz release/xvcache-<id>.tar.gz.sha256 <utilisateur>@91.98.229.110:/tmp/
```

Sur le VPS :

```bash
cd /tmp && sha256sum -c xvcache-<id>.tar.gz.sha256
tar -xzf xvcache-<id>.tar.gz xvcache/deploy/hetzner-cx23-cloudflare   # extrait seulement les scripts
cd xvcache/deploy/hetzner-cx23-cloudflare
```

> Autre possibilité : une fois la branche publiée sur GitHub (décision de Julien), `--git-ref <branche>` clone directement `https://github.com/xvcache/xvcache.git`.

## 4. Installer ou mettre à jour le service ⚠️

```bash
sudo ./install-or-update.sh --check                                  # 1) vérifications seules : ne modifie rien
sudo ./install-or-update.sh --archive /tmp/xvcache-<id>.tar.gz --dry-run   # 2) affiche chaque action sans l'exécuter
sudo ./install-or-update.sh --archive /tmp/xvcache-<id>.tar.gz             # 3) installation réelle
# option : --with-tests lance la suite de tests hors ligne avant d'activer la version
```

Le script est **idempotent**. Le relancer ne casse rien, et une version déjà construite est réutilisée. Il fait, dans l'ordre :

1. **Vérifications** :
   - root, systemd, Node ≥ 20 (26 recommandé), npm, openssl, curl, tar ;
   - port local libre ;
   - `XVCACHE_REMOTE_HOST` local, sinon refus ;
   - alerte si quelque chose écoute publiquement sur 80/443.
2. **Utilisateur système** `xvcache` : sans shell et sans mot de passe.
3. **Dossiers** :
   - `/opt/xvcache/releases/<id>` pour le code (root, lecture seule pour le service) ;
   - `/opt/xvcache/current`, un lien vers la version active ;
   - `/etc/xvcache/` (root:xvcache 0750) ;
   - `/var/lib/xvcache` pour les données (xvcache 0700).
4. **Fichier d'environnement** `/etc/xvcache/xvcache-mcp.env` :
   - copié depuis `.env.example` **seulement s'il n'existe pas** ;
   - jamais écrasé ni affiché ;
   - le script n'y lit que `XVCACHE_REMOTE_PORT` et `XVCACHE_REMOTE_HOST`.
5. **Construction** dans un dossier temporaire :
   - `npm ci --ignore-scripts` (aucun script d'installation tiers exécuté) ;
   - `npm run build` ;
   - `npm prune --omit=dev`.
6. **Unité systemd** `xvcache-mcp.service` (durcie, voir § 9) et minuteur de sauvegarde `xvcache-backup.timer`. Elles ne sont réécrites que si elles ont changé.
7. **Bascule atomique** du lien `current`, avec mémorisation de la version précédente dans `/opt/xvcache/previous`.
8. **Redémarrage et contrôle de santé** : `/healthz` et `tools/list` doivent répondre et exposer `certify_document` / `verify_document`. **En cas d'échec, le script revient tout seul à la version précédente.**
9. **Ménage** : garde les 5 dernières versions (`--keep N`), sans jamais supprimer l'active ni la précédente.

## 5. Configuration (`/etc/xvcache/xvcache-mcp.env`)

Modifier avec `sudo nano /etc/xvcache/xvcache-mcp.env`, puis `sudo systemctl restart xvcache-mcp`.

### 5.1 Valeurs du modèle (`.env.example`, sans secret)

| Variable | Défaut | Rôle |
|---|---|---|
| `XVCACHE_REMOTE_HOST` | `127.0.0.1` | **Ne pas changer.** Le tunnel est le seul accès public |
| `XVCACHE_REMOTE_PORT` | `8787` | Port local. **Doit rester 8787** : c'est la cible de la route du tunnel côté Cloudflare |
| `XVCACHE_PUBLIC_URL` | `https://mcp.xvcache.com` | Base des liens `pdf_url` (valables 24 h) |
| `XVCACHE_REMOTE_DATA` | `/var/lib/xvcache` | Preuves, lots, jetons, abonnements (clés **hachées**) |
| `XVCACHE_BATCH_WINDOW_MS` | `2000` | Fenêtre de regroupement : toutes les empreintes reçues dans ce délai partagent **un seul jeton** |
| `XVCACHE_RETRY_MS` | `300000` | Nouvelle tentative des lots `pending_qualified` toutes les 5 min |
| `XVCACHE_OTS` | `on` | Ancrage OpenTimestamps (Bitcoin, gratuit) en plus |
| `XVCACHE_TSA_PROVIDER` | `freetsa` | `freetsa` (test, non qualifié) / `certigna` (qualifié, payant) / `off` |

### 5.2 Passage à Certigna (qualifié eIDAS) ⚠️ (coût : 1 jeton par lot, décision de Julien)

1. Ajouter dans `/etc/xvcache/xvcache-mcp.env`, **sur le VPS uniquement**, sans jamais copier ces valeurs dans le dépôt, un ticket ou une conversation :
   ```
   XVCACHE_TSA_PROVIDER=certigna
   XVCACHE_TSA_USER=…
   XVCACHE_TSA_PASSWORD=…
   ```
2. Vérifier les droits : `sudo chmod 0640 /etc/xvcache/xvcache-mcp.env && sudo chown root:xvcache /etc/xvcache/xvcache-mcp.env`.
3. Lancer `sudo systemctl restart xvcache-mcp`. Le journal doit afficher `TSA: certigna, qualified`.

À savoir :
- **Le mot de passe passe par systemd** (`EnvironmentFile`). L'application refuse de lire `XVCACHE_TSA_PASSWORD` depuis un fichier `.env` du dépôt, et ne l'écrit jamais dans les preuves ni dans les journaux.
- **Si Certigna répond 402** (crédits épuisés) ou tombe en panne :
  - les preuves passent en `pending_qualified` ;
  - **aucun repli silencieux sur FreeTSA** ;
  - une alerte opérateur apparaît dans `journalctl -u xvcache-mcp` et dans `/var/lib/xvcache/hosted/alerts.log` ;
  - le service retente tout seul toutes les 5 min.
- **Les crédits ne sont pas surveillés** : suivre la consommation chez Certigna.

## 6. Créer une clé API (opérateur, en attendant Stripe / L4)

```bash
sudo -u xvcache env XVCACHE_REMOTE_DATA=/var/lib/xvcache \
  "$(command -v node)" /opt/xvcache/current/dist/remote-server.js --create-key 100
# affiche UNE fois une clé xvc_… (quota de 100 certifications par mois ; sans nombre = pas de plafond)
```

- La clé est un **secret** : la remettre au cabinet par un canal sûr.
- Seule son empreinte SHA-256 est stockée (`/var/lib/xvcache/subscriptions.json`).
- Le client MCP l'envoie dans l'en-tête `Authorization: Bearer xvc_…`, ou `X-API-Key`.

## 7. Tunnel Cloudflare `xvcache-mcp` (géré à distance, par jeton)

**État annoncé par Horizon 2036 / Mochi le 22/11/2026, non revérifié par ce dossier :**
- le tunnel `xvcache-mcp` **existe déjà** en mode géré à distance ;
- sa route publique est `mcp.xvcache.com` → `http://127.0.0.1:8787`, limitée aux chemins `/mcp`, `/healthz` et `/pdf/*.pdf`.

**Rien n'est donc à créer côté Cloudflare** : pas de `cloudflared tunnel create`, pas de `config.yml` local, pas de `tunnel route dns`. Il reste seulement à faire tourner le connecteur sur le VPS avec le jeton du tunnel.

À vérifier, en lecture seule, dans le tableau de bord (Zero Trust → Networks → Tunnels → `xvcache-mcp`) :

| Réglage | Valeur attendue |
|---|---|
| Hostname public | `mcp.xvcache.com` |
| Service | `HTTP` → `127.0.0.1:8787` (identique à `XVCACHE_REMOTE_PORT`) |
| Chemins publiés | `/mcp`, `/healthz`, `/pdf/*.pdf` ; tout le reste → 404 |
| État du connecteur | « Healthy » une fois le § 7.3 fait |

### 7.1 Installer cloudflared (dépôt officiel Cloudflare) ⚠️ (modifie le VPS)

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
cloudflared --version     # le binaire doit être /usr/bin/cloudflared
```

### 7.2 Déposer le jeton du tunnel (fichier 0600) ⚠️

Le jeton est un **secret** : il permet de faire tourner un connecteur du tunnel. Il ne va **jamais** dans le dépôt, un ticket, une conversation ou `/etc/xvcache/xvcache-mcp.env`, que le service applicatif peut lire.

```bash
sudo ./install-or-update.sh --tunnel --dry-run    # montre ce qui sera fait
sudo ./install-or-update.sh --tunnel              # crée /etc/cloudflared/xvcache-tunnel.env (root:root 0600) à partir du modèle,
                                                  # installe cloudflared-xvcache.service, mais NE démarre PAS tant que le jeton manque
sudoedit /etc/cloudflared/xvcache-tunnel.env      # remplacer VOTRE_TOKEN_TUNNEL_CLOUDFLARE par le jeton
```

Le jeton se trouve dans le tableau de bord : Tunnels → `xvcache-mcp` → Configure → commande d'installation. C'est la longue chaîne après `service install`. La copier sans rien exécuter d'autre.

Contenu attendu (modèle `cloudflared-tunnel.env.example`) :

```
CLOUDFLARE_TUNNEL_TOKEN=VOTRE_TOKEN_TUNNEL_CLOUDFLARE
```

### 7.3 Démarrer le connecteur ⚠️

```bash
sudo ./install-or-update.sh --tunnel    # jeton renseigné : active et démarre cloudflared-xvcache.service
systemctl status cloudflared-xvcache --no-pager
journalctl -u cloudflared-xvcache -n 30 --no-pager   # "Registered tunnel connection" ×4 attendu
```

Ou, en une fois avec l'application : `sudo ./install-or-update.sh --archive /tmp/xvcache-<id>.tar.gz --with-tunnel`.

L'unité `cloudflared-xvcache.service` :
- lit le jeton dans le fichier 0600 grâce à systemd (`EnvironmentFile`) ;
- le passe à cloudflared par la variable `TUNNEL_TOKEN`, que cloudflared lit nativement ;
- n'expose le jeton **ni dans `ps`, ni dans le fichier d'unité** ;
- tourne sous un utilisateur éphémère (`DynamicUser`), sans capacité Linux, avec `--no-autoupdate` (les mises à jour passent par apt) ;
- n'ouvre **aucun port** : seulement des connexions sortantes vers Cloudflare, en 7844/udp ou tcp et 443/tcp.

Pour éviter des inquiétudes inutiles : le script vérifie seulement si le jeton est renseigné (présence du texte modèle, ligne non vide). Il ne l'affiche jamais, et filtre les journaux qu'il montre en cas d'erreur.

### 7.4 Ne garder qu'un seul connecteur

La commande proposée par Cloudflare, `sudo cloudflared service install <TOKEN>`, marche aussi. Mais elle crée `cloudflared.service` avec le jeton **écrit en clair dans la ligne de commande du service**, visible dans `ps` et dans le fichier d'unité. Ce dossier la remplace par `cloudflared-xvcache.service`.

Si elle a déjà été lancée sur le VPS :

```bash
systemctl is-enabled cloudflared 2>/dev/null && echo "cloudflared.service présent"
# pour basculer vers l'unité par fichier 0600 (⚠️ coupe le tunnel quelques secondes) :
sudo systemctl disable --now cloudflared && sudo cloudflared service uninstall
sudo ./install-or-update.sh --tunnel
```

`--check` et `--tunnel` avertissent si les deux connecteurs coexistent. Cela marcherait (deux répliques), mais ce serait le jeton en clair plus un doublon inutile.

### 7.5 Régénérer le jeton (en cas de fuite)

Faire tourner le jeton du tunnel, depuis le tableau de bord (fiche du tunnel `xvcache-mcp`) ou par l'API Cloudflare ⚠️ (modifie Cloudflare, décision de Julien). L'ancien jeton cesse alors de fonctionner. Puis mettre le nouveau jeton dans `/etc/cloudflared/xvcache-tunnel.env` et lancer `sudo systemctl restart cloudflared-xvcache`.

### 7.6 Réglages Cloudflare recommandés (décisions de Julien)

- **Ne pas** mettre de défi navigateur (Bot Fight Mode, Under Attack, Managed Challenge) sur `mcp.xvcache.com` : les assistants IA ne savent pas résoudre un défi, et le MCP cesserait de marcher.
- **Ajouter une règle de limitation de débit** (WAF → Rate limiting) sur `mcp.xvcache.com/mcp`, par exemple 60 requêtes par minute et par IP. L'application n'a pas encore de limitation intégrée, et `verify_document` est gratuit et sans clé.

## 8. Vérifications

Sur le VPS :

```bash
systemctl status xvcache-mcp --no-pager
journalctl -u xvcache-mcp -n 50 --no-pager          # "xvcache-remote listening on http://127.0.0.1:8787/mcp (TSA: …)"
/opt/xvcache/current/deploy/hetzner-cx23-cloudflare/check-health.sh            # contrôle local
sudo ss -ltnp                                        # attendu : 22 (sshd) + 127.0.0.1:8787 (node) ; rien sur 0.0.0.0:80/443/8787
```

Depuis n'importe quel poste :

```bash
deploy/hetzner-cx23-cloudflare/check-health.sh https://mcp.xvcache.com
curl -m 5 http://91.98.229.110:8787/healthz   # DOIT échouer (port non exposé)
```

`check-health.sh` ne certifie rien, ne consomme aucun jeton et n'utilise aucune clé. Il contrôle :
- `/healthz` ;
- la présence des outils ;
- `get_offer` sans clé ;
- `certify_document` sans clé → `PAYMENT_REQUIRED` ;
- texte non haché → `HASH_INVALID` ;
- route inconnue → 404.

Ce contrôle a été validé en local sur une construction de production (archive → `npm ci --ignore-scripts` → build → `prune`) : tout est OK.

Test d'une vraie certification, avec une clé de test (§ 6) et le fournisseur FreeTSA (gratuit) :

```bash
curl -s https://mcp.xvcache.com/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $XVCACHE_TEST_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"certify_document","arguments":{"sha256":"'"$(printf test | sha256sum | cut -d' ' -f1)"'","label":"Test","lang":"fr"}}}'
```

## 9. Durcissement de l'unité systemd

`xvcache-mcp.service` :
- utilisateur dédié, `NoNewPrivileges`, aucune capacité Linux ;
- `ProtectSystem=strict` : tout le système en lecture seule sauf `/var/lib/xvcache`, via `StateDirectory`, en mode 0700 ;
- `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ProtectKernel*`, `ProtectProc=invisible` ;
- `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` ;
- `SystemCallFilter=@system-service` sans `@privileged` ;
- `UMask=0077`, `MemoryMax=512M`, `TasksMax=256`.

`MemoryDenyWriteExecute` est volontairement absent : le JIT de V8 en a besoin.

Score `systemd-analyze security --offline=true` mesuré en local : **1.4 OK** (0 = le plus strict, 10 = aucun durcissement). À revérifier sur le VPS : `systemd-analyze security xvcache-mcp`.

## 10. Mise à jour

Fabriquer une nouvelle archive (§ 3), l'envoyer, puis :

```bash
sudo ./install-or-update.sh --archive /tmp/xvcache-<nouvel-id>.tar.gz --dry-run
sudo ./install-or-update.sh --archive /tmp/xvcache-<nouvel-id>.tar.gz
```

Les données (`/var/lib/xvcache`) et le fichier d'environnement ne sont pas touchés. Coupure : quelques secondes au redémarrage. Une certification en cours pendant le redémarrage peut échouer côté client, qui doit réessayer. Au pire, une unité de quota est consommée sans preuve : faire les mises à jour aux heures creuses.

## 11. Retour arrière

- **Automatique** : si le contrôle de santé échoue après une mise à jour, le script revient seul à la version précédente.
- **Manuel** :
  ```bash
  sudo /opt/xvcache/current/deploy/hetzner-cx23-cloudflare/install-or-update.sh --rollback --dry-run
  sudo /opt/xvcache/current/deploy/hetzner-cx23-cloudflare/install-or-update.sh --rollback
  ```
- **Vers une version plus ancienne** (gardée dans `/opt/xvcache/releases/`) :
  ```bash
  sudo ln -sfn releases/<id> /opt/xvcache/current.new && sudo mv -T /opt/xvcache/current.new /opt/xvcache/current
  sudo systemctl restart xvcache-mcp && /opt/xvcache/current/deploy/hetzner-cx23-cloudflare/check-health.sh
  ```
- **Couper l'accès public sans arrêter le service** : `sudo systemctl stop cloudflared-xvcache`.
- **Tout arrêter** : `sudo systemctl stop cloudflared-xvcache xvcache-mcp`.

Le format des données n'a pas changé entre les versions de cette branche. Si une future version le modifie, ses notes devront le dire avant tout retour arrière.

## 12. Sauvegardes et restauration

- **Contenu** : `xvcache-backup.timer` lance `backup.sh` chaque jour à 03:15. Il archive `/var/lib/xvcache` (preuves, lots, jetons `.tst` / `.ots`, `subscriptions.json`) dans `/var/backups/xvcache/xvcache-data-<date>.tar.gz` avec sa somme SHA-256, puis purge les PDF temporaires de plus de 25 h. Rétention : 30 jours.
- **Pas sauvegardés** : `/etc/xvcache/xvcache-mcp.env` (il peut contenir le mot de passe Certigna) et `/etc/cloudflared/xvcache-tunnel.env` (jeton du tunnel). Garder ces secrets dans le gestionnaire de mots de passe.
- **Sauvegarde manuelle** : `sudo /opt/xvcache/current/deploy/hetzner-cx23-cloudflare/backup.sh`
- **Copie hors du VPS** (indispensable, décision de Julien) : par exemple les snapshots Hetzner, une Storage Box, ou `rclone` / `restic` vers un stockage chiffré. **Les preuves sont irremplaçables** : sans le fichier de preuve, un cabinet ne peut plus faire vérifier son certificat en ligne.
- **Restauration** :
  ```bash
  sudo systemctl stop xvcache-mcp
  sha256sum -c /var/backups/xvcache/xvcache-data-<date>.tar.gz.sha256
  sudo mv /var/lib/xvcache /var/lib/xvcache.avant-restauration
  sudo tar -xzf /var/backups/xvcache/xvcache-data-<date>.tar.gz -C /var/lib
  sudo chown -R xvcache:xvcache /var/lib/xvcache && sudo chmod 0700 /var/lib/xvcache
  sudo systemctl start xvcache-mcp && /opt/xvcache/current/deploy/hetzner-cx23-cloudflare/check-health.sh
  ```

## 13. Désinstallation ⚠️

```bash
sudo systemctl disable --now xvcache-mcp xvcache-backup.timer
sudo rm -f /etc/systemd/system/xvcache-mcp.service /etc/systemd/system/xvcache-backup.{service,timer} && sudo systemctl daemon-reload
sudo rm -rf /opt/xvcache            # code seulement ; /var/lib/xvcache (données) et /var/backups/xvcache à garder ou archiver d'abord
# Connecteur : sudo systemctl disable --now cloudflared-xvcache ; sudo rm -f /etc/systemd/system/cloudflared-xvcache.service /etc/cloudflared/xvcache-tunnel.env
# (le tunnel et le CNAME restent chez Cloudflare : les supprimer est une décision de Julien ⚠️)
```

## 14. Dépannage

| Symptôme | Piste |
|---|---|
| `install-or-update.sh` : « le port 8787 est déjà utilisé » | `sudo ss -ltnp 'sport = :8787'`, puis libérer le port. Le tunnel vise 8787 : changer de port oblige à modifier la route côté Cloudflare ⚠️ |
| Le service redémarre en boucle | `journalctl -u xvcache-mcp -n 100`. Souvent : Certigna mal configuré (« XVCACHE_TSA_USER et XVCACHE_TSA_PASSWORD sont requis »), ou Node trop ancien |
| `https://mcp.xvcache.com` répond 502 / 1033 | 1033 : aucun connecteur actif → `systemctl status cloudflared-xvcache`, `journalctl -u cloudflared-xvcache`, jeton renseigné ? port 7844 sortant ? 502 : connecteur actif mais application muette → `check-health.sh` en local |
| `cloudflared-xvcache` : « Provided Tunnel token is not valid » | Jeton mal copié, ou régénéré entre-temps (§ 7.5) |
| Un client MCP reçoit une page HTML de défi | Un réglage anti-bot Cloudflare est actif sur `mcp.xvcache.com` : le désactiver (§ 7.6) |
| Preuves en `pending_qualified` | Certigna indisponible ou crédits épuisés (402). Voir `/var/lib/xvcache/hosted/alerts.log`. Le service retente toutes les 5 min |
| `QUOTA_EXCEEDED` | Quota mensuel de la clé atteint. Remise à zéro le 1er du mois (UTC) |

## 15. Ce qui reste à décider ou à faire

- Accord de Julien pour : installer l'application et le connecteur sur le VPS (le tunnel et la route existent déjà), et choisir le moment du passage à Certigna (coût).
- Copie des sauvegardes hors du VPS (§ 12) et règle de limitation de débit Cloudflare (§ 7.6).
- L4 : Stripe et webhook vers l'activation des abonnements. Ensuite, plus besoin de `--create-key`.
- L6 : stockage en base de données. Le fichier JSON actuel suppose une seule instance. Supervision (alertes Certigna envoyées par e-mail plutôt que dans le journal).
- Limitation de débit dans l'application elle-même, et purge plus fine des PDF temporaires.

## Stripe (lot L4) — webhook et lien de paiement

- Route : `POST https://mcp.xvcache.com/stripe/webhook` (signature `Stripe-Signature` vérifiée avec `STRIPE_WEBHOOK_SECRET`, tolérance 5 min, chaque événement appliqué une seule fois).
- Événements à cocher sur l'endpoint : `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.dispute.created`.
- Le serveur n'a besoin d'**aucune clé secrète Stripe** : `request_upgrade` renvoie le lien de paiement avec `client_reference_id` = référence publique de l'appairage (`xvr_…`, dérivée du haché du code ; le code d'appairage ne part jamais chez Stripe). Au `checkout.session.completed`, la clé API `xvc_…` est créée, liée au client et à l'abonnement Stripe, et remise une seule fois par `get_subscription(pairing_code)`.
- Statuts : `active` / `trialing` → outils payants ouverts ; `past_due` (échec de paiement) ou `canceled` (résiliation) → `PAYMENT_REQUIRED`. Un litige (`charge.dispute.created`) est seulement signalé (`disputed_at`), sans coupure automatique.
- Paiement sans référence (lien ouvert directement) : noté dans `unlinked_checkouts` de `/var/lib/xvcache/subscriptions.json`, aucune clé créée (l'opérateur crée la clé avec `xvcache-remote --create-key`).
- Secrets : `/etc/xvcache/stripe.env` (root, 0600), modèle `stripe.env.example`. Journal : `journalctl -u xvcache-mcp | grep xvcache-billing` (identifiants et types d'événements seulement).
