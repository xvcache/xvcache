# Proposition — nommer aussi le fichier `rapport.pdf` (non appliquée)

Cette note est **non destructive** et **n'est pas implémentée**. Le fichier produit aujourd'hui s'appelle toujours `certificat.pdf`. Les noms d'API (`get_certificate_pdf`, `certificatePdf`, chemins `/pdf/*`, paquets existants) restent inchangés jusqu'à un accord explicite.

## Objectif

Sophie recommande d'appeler le document un **Rapport PDF** / "PDF report", jamais un « certificat » (risque de pratique commerciale trompeuse, L121-2 C. conso). Le libellé visible (titres des locales, descriptions d'outils, site) est déjà aligné. Le nom de fichier `certificat.pdf` reste un point ouvert (voir aussi le CHANGELOG 0.3.0).

## Proposition

1. **Écrire** désormais `rapport.pdf` (ou un équivalent du même dossier) dans les nouveaux paquets de preuve.
2. **Continuer d'accepter** `certificat.pdf` : paquets déjà émis, URL `/pdf/*` historiques, clients et tests qui cherchent ce nom, outils `get_certificate_pdf` / `certificatePdf`.
3. Lors d'une revérification ou d'une réémission, produire `rapport.pdf` et, si un `certificat.pdf` existe déjà, le laisser en place ou le traiter comme alias (même contenu).
4. Mettre à jour les tests et les snapshots ; ajouter des cas « ancien paquet avec seulement `certificat.pdf` » et « nouveau paquet avec `rapport.pdf` (+ alias éventuel) ».

## Fichiers probablement concernés (à confirmer à l'implémentation)

- `src/certificate.ts` (écriture du PDF et des pièces jointes)
- `src/witness.ts`, `src/export-certificate.ts`, `src/remote.ts` (publication `/pdf/…`)
- `src/demo-server.ts` (chemin `/certificat` et fichier `certificat.pdf` — l'URL peut rester pour compatibilité)
- Tests et snapshots : `src/certificate.test.ts`, `src/certificate-i18n.test.ts`, `test/snapshots/certificate/`
- Documentation : `README.md`, `docs/TOOLS.md`, `CHANGELOG.md`

Ne pas renommer les certificats X.509 de la TSA ni les fichiers d'autorité (`certs/*.pem`).

## Risques

- Liens déjà transmis (`…/certificat.pdf`, pièces d'un dossier client) cassés si l'on arrête d'accepter l'ancien nom.
- Clients ou scripts qui cherchent uniquement `certificat.pdf` dans le paquet.
- Confusion entre le Rapport PDF et le certificat X.509 de la TSA si le mot « certificat » disparaît aussi des commentaires techniques mal ciblés.
- Double fichier dans les paquets transitoires (poids négligeable, mais à documenter).

## Décision

Aucune modification de code n'est faite ici. À n'implémenter qu'après accord de Julien, avec tests de migration et conservation de `certificat.pdf` en lecture.
