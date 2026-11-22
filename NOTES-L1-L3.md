# XVcache MCP agentique — lots L1 à L3 (local, non publié)

Branche `feat/mcp-agentique-l1-l3` (worktree `/workspace/xvcache-l1-l3`), partie de `e4abe64`.
Spec : `Horizon-2036/XVcache-Spec-MCP-Agentique.md`. Rien n'est poussé, publié ni facturé.

## Fait

### L1 — écart 3 : certificat dans les 24 langues de l'UE
- `locales/<24>.json` (section `cert` + section `offer`), `src/i18n.ts` (langue, repli en, date locale + UTC, fuseau par défaut Europe/Brussels).
- Polices DejaVu embarquées (`fonts/`, licence Bitstream Vera) : grec, bulgare et tous les diacritiques.
- `certify_document` et `get_certificate_pdf` acceptent `lang` / `tz` ; le PDF est renvoyé en ressource MCP intégrée.
- Bandeau « NON QUALIFIÉ » dès que le jeton n'est pas qualifié ou est en attente.
- Mentions § 6.2 : art. 41 eIDAS, « XVcache n'est pas un PSCQ », limites, empreinte seule.
- Ré-émission dans une autre langue sans nouveau jeton.
- Tests : 24 instantanés texte (`test/snapshots/certificate/`, régénérables avec `UPDATE_SNAPSHOTS=1`), pire cas (libellé de 120 caractères + en attente), ré-émission.

### L2 — écarts 2, 4, 5 : offre, présentation, une seule question
- `plans.json` 0.3.0 : `coffre-horodate` à 19 € HT / mois / cabinet, statut `to_test`, essai de 14 jours `to_test`, quotas TBD.
- `get_offer` et `list_plans` localisés, plus `present_to_client` : message de moins de 150 mots et `consent_prompt` exact.
- `request_upgrade` : `CONSENT_REQUIRED` / `PLAN_UNKNOWN` / `BILLING_UNAVAILABLE` (Stripe = L4). L'interface `Billing` est prête.
- Format d'erreur unique `{code, message_localized, retryable, next_action}` (`src/errors.ts`).
- Test d'audit : aucune consigne « demander à l'humain » hors consentement. `llms.txt` a un en-tête UE.

### L3 — écarts 6, 8, 9, 10 : serveur distant « empreinte seule »
- `src/remote.ts` + `src/remote-server.ts` (bin `xvcache-remote`) : Streamable HTTP sans état, 127.0.0.1, port fourni par l'environnement (0 = port libre).
- Clé API : `Authorization: Bearer xvc_…` ou `X-API-Key`.
- Outils sans clé : get_offer, list_plans, recommend_plan, present_to_client, request_upgrade, get_subscription(pairing_code), verify_document / verify_proof.
- Outils avec clé : certify_document, certify_hash, get_certificate_pdf, get_usage. Sans clé, ils renvoient `PAYMENT_REQUIRED` + `next_tool: present_to_client`.
- Rejet de tout ce qui n'est pas 64 hex (`HASH_INVALID`), y compris un champ `content` ; libellé ≤ 120 caractères.
- `src/subscriptions.ts` : clés et codes d'appairage stockés hachés, clé montrée une seule fois.
  - Quota mensuel : `QUOTA_EXCEEDED` + `next_reset`.
  - Appairage : `NOT_PAID_YET` / `PAIRING_EXPIRED`.
  - Opérateur : `xvcache-remote --create-key [quota]`.
- `src/witness.ts` : lots Merkle partagés entre cabinets sur une fenêtre de temps (1 jeton pour tous). La feuille `{k:"hash", id, h}` ne nomme aucun cabinet.
- PDF : lien de téléchargement de 24 h (`/pdf/<jeton>.pdf`) en plus du fichier intégré.
- Certigna 402 ou panne :
  - la preuve passe en `pending_qualified` (OTS si activé), sans aucun repli silencieux sur FreeTSA ;
  - l'opérateur reçoit une alerte (stderr + `alerts.log`, sans secret) ;
  - `requalifyPending()` relance périodiquement ;
  - le PDF « en attente » porte le bandeau NON QUALIFIÉ.

## Choix
- Travail dans un worktree séparé : le serveur de test ChatGPT d'Horizon tourne depuis `/workspace/xvcache-repo/dist`. `buildCertificatePdf` / `formatParisDateTime` restent compatibles pour son `live-server.ts`.
- Langue par défaut : `en` pour les outils MCP (spec) ; `fr` pour la bibliothèque `handleDocument` (compatibilité).
- Toutes les langues sauf `en` sont `reviewed:false` : le PDF dit que la traduction n'est pas relue et que l'anglais prévaut.
- Le texte de l'art. 41 est une paraphrase fidèle, pas la version officielle EUR-Lex de chaque langue.
- Messages d'erreur en anglais (`message_lang: "en"`) ; l'IA les reformule.
- Stockage des abonnements : un fichier JSON (une seule instance). Base de données = L6.
- Tests : uniquement la fausse TSA locale (`src/test-tsa.ts`) et un fetch qui simule le 402. Aucun appel à Certigna réel ni à Stripe.
- Tests existants modifiés, avec justification :
  - l'extraction de texte PDF lit les CMaps ToUnicode (polices embarquées) ;
  - le prix n'est plus TBD pour coffre-horodate ;
  - `request_upgrade` répond désormais `BILLING_UNAVAILABLE`.

## Reste à faire
- **L4** Stripe (compte XVcache dédié, Checkout, webhook → `activatePairing`).
- **L5** README / résumés en 24 langues dans `docs/i18n`, `server.json` « remotes », registre MCP.
- **L6** base de données, déploiement, OAuth éventuel.
- **L7** domaine, site, CGV, RGPD.
- Hors lots ou non couverts :
  - QR code de vérification sur le PDF ;
  - libellés officiels EUR-Lex et relecture juridique des 24 langues ;
  - messages d'erreur localisés ;
  - quotas réels du plan ;
  - prix final (décision de Julien) ;
  - fusion dans `main` (vérifier `live-server.ts` d'Horizon) ;
  - instantanés dépendants de la version ICU/Node.
