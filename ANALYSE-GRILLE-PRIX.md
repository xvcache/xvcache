# Note interne — analyse de la grille tarifaire prévue (ne pas publier telle quelle)

Textes validés par Julien le 23 novembre 2026 à 11h30 (Europe/Paris), sur la formule de Sophie (11h28, complément B4 bis à 11h32). Rien n'est en vente. Aucun appel Stripe, aucun push, aucune publication. Cette note décrit ce que demanderaient côté code trois points de la grille ; rien n'a été développé ici.

Libellés retenus (extraits) : « Tarifs prévus, pas encore en vente » / "Planned pricing, not on sale yet" ; Essentiel 29 € HT / mois, 1 utilisateur, preuves non plafonnées dans le cadre d'un usage raisonnable défini par les CGV ; Cabinet 59 € HT / mois, jusqu'à 5 utilisateurs, avec un Rapport PDF à vos couleurs ; prix de lancement 19 € HT / mois pour l'offre Essentiel, réservé aux 50 premières organisations abonnées, garanti tant que l'abonnement reste actif sans interruption (conditions : [CGV, article B4 bis](https://xvcache.com/fr/conditions-utilisation/#b4-bis)). Pas de « à vie », pas d'« illimité », pas de compteur public, pas de date limite, places non réattribuées, prix ferme (`price_locked`).

## (a) Cabinet = jusqu'à 5 utilisateurs

Aujourd'hui le modèle hébergé est une clé d'API par abonnement / organisation, sans comptes membres. Pour Cabinet il faudrait :

- un modèle organisation / membres : une organisation (SIREN ou numéro d'entreprise), un administrateur, jusqu'à 5 utilisateurs, chacun étant une personne physique nommée, accès non partagé (définition à figer dans les CGU) ;
- l'auth : invitation, acceptation des CGU par chaque utilisateur, retrait, rôles (admin / membre) ;
- des clés : une clé par utilisateur, ou une clé d'organisation plus des sessions ; révocation unitaire sans couper l'organisation ;
- des quotas / compteurs partagés au niveau de l'organisation (les preuves ne sont pas plafonnées, sous usage raisonnable) — pas un quota par siège ;
- la facturation : forfait Cabinet (59 € HT / mois) pour jusqu'à 5 utilisateurs, pas un prix par siège ; le dépassement à 6 personnes n'est pas spécifié (refus d'invitation, ou passage hors grille — à trancher avant de coder) ;
- les passages Essentiel (1 utilisateur) ↔ Cabinet (jusqu'à 5), prorata, et l'effet sur le prix de lancement (perdu en cas de passage à Cabinet, selon Sophie).

Fichiers probablement concernés (sans les modifier maintenant) : `src/subscriptions.ts`, le magasin de clés / pairings, `src/remote.ts` / `src/remote-server.ts`, les outils `get_subscription` et `get_usage`, plus plus tard un portail d'invitation. Les CGU (comptes multi-utilisateurs) restent à rédiger par Sophie.

Effort indicatif : 5 à 10 jours pour un socle organisation / membres / clés, hors portail poli et hors Stripe. Risques : partage de clé (contourner le plafond de 5), définition juridique d'« utilisateur », migration des clés actuelles `coffre-horodate`, et toute facturation siège vs forfait si le besoin évolue.

## (b) Rapport PDF à vos couleurs

Sophie écarte « au nom du client », qui laisserait croire que le client émet l'horodatage. Il s'agit d'un Rapport PDF à vos couleurs (logo et nom du client / de l'organisation abonnée), réservé à Cabinet.

Côté code, il faudrait :

- un champ « client final / organisation affichée » (nom, logo), distinct de RENO'LINE et de Certigna, avec validation (droits sur le logo, formats, taille) ;
- l'en-tête et les mentions du modèle PDF (`src/certificate.ts` et libellés des locales) : mentions non supprimables — « Horodatage émis par Certigna », « Service XVcache édité par RENO'LINE SARL », « Ce rapport n'est pas un certificat », plus la méthode de vérification ;
- le client garantit ses droits sur son logo et l'usage du rapport auprès de ses propres clients ; il ne peut pas se présenter comme prestataire de confiance ni comme émetteur de l'horodatage ; marque Certigna en citation factuelle seulement ;
- impact sur la preuve : le jeton, l'empreinte et le chemin de Merkle ne changent pas ; seul le habillage du rapport change. Un rapport personnalisé ne doit pas être pris pour un certificat, ni modifier le verdict V/X. `verify_document` / `get_certificate_pdf` doivent rester cohérents (même preuve, même mentions obligatoires).

Effort indicatif : 3 à 6 jours (modèle PDF, stockage du logo, validations, mentions verrouillées, tests visuels FR/EN au minimum). Risques : un habillage trop « officiel » qui ressemble à un certificat ; oubli d'une mention obligatoire ; usage de la marque Certigna au-delà de la citation factuelle ; un champ « au nom de » mal nommé.

## (c) Prix de lancement : 19 € HT / mois pour l'Essentiel, 50 premières organisations

Règles retenues : le 19 € s'applique seulement à l'offre Essentiel ; 50 premières organisations abonnées (une place = une organisation, un SIREN ou numéro d'entreprise) ; place non réattribuée (`seats_reassignable: false`) ; pas de date limite ; prix ferme (`price_locked: true`), garanti tant que l'abonnement reste actif sans interruption (conditions : [CGV, article B4 bis](https://xvcache.com/fr/conditions-utilisation/#b4-bis)). Pas de compteur public tant qu'il n'y a pas de données réelles ; pas d'urgence commerciale ; pas de prix barré.

Côté code, plus tard et seulement avec un accord direct de Julien pour Stripe :

- un compteur / registre interne (date, SIREN, n° d'abonnement Stripe) ; l'ordre est celui du premier paiement réussi (horodatage Stripe) ; démos, essais et pré-inscriptions ne comptent pas ; une place libérée n'est pas réattribuée ;
- un prix ou un coupon Stripe dédié, à créer plus tard avec accord, distinct du prix Essentiel à 29 € ; pas d'objet Stripe aujourd'hui ;
- les conditions d'interruption, de résiliation puis réabonnement (perte définitive du prix de lancement), de passage à Cabinet (prix Cabinet 59 €), d'indexation (le prix de lancement échappe à une révision B4.2) et de cession : à écrire par Sophie dans l'article B4 bis, puis à refléter dans le moteur d'abonnement.

Fichiers probablement concernés plus tard : un registre des 50, le fournisseur de facturation (L4 / Stripe Checkout), `request_upgrade` (choix du prix essentiel vs lancement selon les places restantes au moment du paiement réel). Rien de cela n'est branché aujourd'hui : `payment_live` reste false, `request_upgrade` renvoie `BILLING_UNAVAILABLE`.

Effort indicatif : 2 à 4 jours une fois Stripe autorisé (prix dédié, registre, tests de non-réattribution), hors rédaction CGV. Risques : compter une démo comme une place ; réattribuer une place libérée ; appliquer le 19 € au Cabinet ; afficher un compteur public fictif ; créer un prix Stripe sans accord.

## Synthèse

| Sujet | Effort indicatif | Blocage principal |
| --- | --- | --- |
| Cabinet, jusqu'à 5 utilisateurs | 5–10 jours | modèle d'identité et CGU membres |
| Rapport PDF à vos couleurs | 3–6 jours | mentions non supprimables et risque « certificat » |
| Prix de lancement, 50 organisations | 2–4 jours après accord Stripe | article B4 bis + feu vert Stripe de Julien |

Les textes publics et `plans.json` portent déjà la grille prévue (`planned: true`, `demo_applications_only: true`). Le développement ci-dessus n'est pas commencé.
