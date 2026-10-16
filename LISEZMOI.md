# XIA SHOP

Boutique en ligne avec espace vendeur : statistiques de visites, parcours d'achat, sondage clients, avis, fichier prospects avec score, commandes WhatsApp.

- Boutique : `https://VOTRE-ADRESSE/`
- Espace vendeur : `https://VOTRE-ADRESSE/admin` (mot de passe = variable `ADMIN_PASSWORD`)

## Lancer sur un ordinateur (test)
Node.js 22.13 ou plus récent, aucune installation de paquet nécessaire :

    ADMIN_PASSWORD=monmotdepasse npm start

Puis ouvrir http://localhost:3000

## Données
Tout est enregistré dans le dossier `DATA_DIR` (base SQLite `xiashop.db` + photos dans `uploads/`).
Sur Render, ce dossier est le disque `/data` : il est conservé entre les mises à jour.
Sauvegarde conseillée : exporter régulièrement les prospects (bouton « Exporter » de l'onglet Prospects).

## Mesurer vos canaux
Ajoutez `?utm_source=facebook` (ou `tiktok`, `statut`, `instagram`…) à la fin du lien que vous partagez.
Le tableau de bord montre alors d'où viennent vos visiteurs.
