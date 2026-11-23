# Publication de la 0.3.0 — notes locales (ne pas exécuter sans accord)

Document de préparation. **Rien n'a été publié** depuis ce fichier. Pas de `git push`, pas de `npm publish`, pas de `npm deprecate`, pas de déploiement.

## Avant toute publication

- Accord explicite de Julien.
- Confirmer la version et le mode réellement déployés sur `https://mcp.xvcache.com/mcp` (0.2.0 ou 0.3.0, `daily` ou non). Tant que ce n'est pas confirmé, les textes publics parlent de la racine quotidienne au futur / « à partir de 0.3.0 ».
- Le point d'accès hébergé actuellement déployé utilise FreeTSA (non qualifié). Ne pas publier que `mcp.xvcache.com` émet déjà des jetons Certigna tant qu'un jeton `.tst` émis par la production n'a pas été vérifié hors ligne (OID, émetteur) et n'a pas obtenu PASSED / Qualified timestamp dans l'outil de validation DSS de la Commission européenne (version de démonstration en ligne).
- Les mentions DSS du site (`dss_howto`, `dss_howto_short`, `llms_q_dss`, complément de `step3_note`) restent exclues du build tant que `_dss_mention.publish` est `false` (même condition).

## Dépréciation de la 0.2.0 (préparée, non lancée)

Paquet npm : `xvcache-mcp` (voir `package.json`).

À lancer **seulement après la publication de la 0.3.0, avec l'accord de Julien** :

```bash
npm deprecate xvcache-mcp@0.2.0 "Superseded by 0.3.0 (daily shared Merkle root, updated legal wording). Please upgrade. / Remplacée par la 0.3.0 (racine de Merkle quotidienne, textes juridiques mis à jour). Merci de mettre à jour."
```

Ne pas exécuter cette commande maintenant. La page npm de la 0.2.0 conserve son README d'origine tant qu'aucune nouvelle version n'est publiée.

## Autres étapes (également sur feu vert seulement)

- `npm publish` de la 0.3.0 (paquet `xvcache-mcp`).
- Mise à jour du registre MCP (`server.json`, nom `io.github.xvcache/xvcache`).
- Déploiement hébergé, ouverture des ventes (`XVCACHE_SALES_OPEN=1` et lien Stripe live, jamais un lien `buy.stripe.com/test_`).
