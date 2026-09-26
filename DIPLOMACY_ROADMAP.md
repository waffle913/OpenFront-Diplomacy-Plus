# Diplomacy+ — Roadmap de développement et de test

Mise à jour : 26 septembre 2026.
Statut : développement actif ; les lots marqués « vérifiés techniquement » attendent encore une validation en partie.

## Vision retenue

Transformer OpenFront en un monde de nations mêlant stratégie territoriale, économie et géopolitique. Conserver la formation dynamique des nations au début de partie et la compatibilité avec différentes cartes, plutôt que dépendre de frontières historiques prédéfinies.

Le joueur et les IA utilisent les mêmes règles et possibilités diplomatiques et commerciales. Les relations appartiennent aux pays ; les dirigeants influencent les décisions sans effacer les traités, les obligations ou la mémoire du pays lors d'une succession.

Garder dès la conception la possibilité de confier les décisions politiques à un LLM. Le jeu reste pleinement fonctionnel sans LLM.

## État actuel — Diplomacy+ V2, candidate de test

- Régions historiques et objectifs de guerre régionaux présents.
- Paix automatique et trêves d'après-guerre de 1 200 ticks présentes.
- Onglet TRUCES, compte à rebours et distinction avec les NAP présents.
- Blocage des nouvelles attaques pendant une trêve corrigé ; retour des transports concernés prévu dans le code.
- Économie stratégique active : production, consommation, pénuries, logistique militaire, matériaux de construction et commerce bilatéral récurrent.
- Relations structurées, intérêts nationaux, gouvernements successifs, coopération, crises temporisées et paix négociée présents dans une première version jouable.
- Passerelle de décisions politiques structurées prête pour un futur pilote LLM ; aucun service externe n'est requis pour jouer.
- Registre diplomatique central ajouté : propositions immuables, réponses différées, contre-propositions, expiration, invalidation et application atomique.
- Premier incident persistant branché sur la saisie d'un navire commercial. La victime peut protester, abandonner l'affaire ou réclamer des réparations, y compris pendant la pause.
- Première tranche d'IA diplomatique active : protestation et réparations après un incident, ainsi que propositions espacées de commerce, pacte ou paix fondées sur l'agenda national.
- Négociation d'incident complétée : restitution, excuses, médiation, sanctions, ultimatum et casus belli graduels.
- Cinq factions politiques légères influencent maintenant les évaluations diplomatiques et évoluent selon la guerre, le commerce, les pertes et l'isolement.
- Première paix territoriale régionale : `CedeRegion` transfère une région historique et ses structures dans un règlement atomique, avec revalidation au moment de l'application.
- Contrôles solo existants : pause et vitesses dont ×0,5.
- Dernière vérification : 122 tests ciblés passent, TypeScript compile et le renderer de production est construit (empreinte cœur `f7f19cebb3c3`).
- Candidate V2 installée dans le renderer Steam le 24 septembre 2026 ; `index.html` et `asset-hashes.json` correspondent exactement au build. La sauvegarde stable V1.16.1 reste disponible pour restauration.
- Validation en partie : après installation du correctif de blocage des trêves, le joueur a confirmé que cela fonctionne. Les cas limites restent à surveiller pendant les essais suivants.

## Méthode de travail

1. Prendre un petit lot de l'étape active et annoncer son comportement attendu.
2. Sauvegarder, implémenter et vérifier les règles touchées avec des tests pertinents, puis compiler.
3. Installer la version testable lorsque le jeu est fermé, en conservant un retour arrière.
4. Fournir au joueur un court scénario de test et préciser ce qui reste incomplet.
5. Recueillir ses observations : résultat attendu, résultat réel et circonstances. Une capture est utile mais facultative.
6. Corriger en priorité les blocages, pertes de ressources, contournements des règles et régressions.
7. Marquer le lot « validé en partie » uniquement après un retour du joueur. Passer au lot suivant lorsque les défauts bloquants sont corrigés.

États à employer : à concevoir → en développement → vérifié techniquement → à tester en partie → validé en partie. Un test automatisé réussi ne vaut pas validation de l'équilibrage.

## Ordre des étapes

### 0. Confirmer la stabilité du socle actuel

**Statut : fonctionnement confirmé par le joueur ; cas limites à surveiller.**

Objectif : disposer d'une base fiable avant d'ajouter des systèmes.

À vérifier :

- Une trêve interdit les attaques dans les deux sens sans consommer de troupes.
- Une invasion en mer ne permet pas de contourner une trêve signée après son départ.
- Une attaque redevient possible à l'expiration.
- Une région inaccessible ne consomme pas de soldats.
- Une guerre justifiée ou injustifiée se termine lorsque son objectif régional est accompli.
- Les autres régions du défenseur restent protégées par la limite opérationnelle.
- Les NAP volontaires restent distincts : leur rupture entraîne les conséquences prévues, alors qu'une trêve bloque l'attaque.

Toute brèche constatée devient prioritaire. Les chemins d'attaque supplémentaires, notamment les armes spéciales, doivent être examinés avant de considérer le cessez-le-feu comme entièrement couvert.

### 1. Temps du monde et rythme — étape active

**Lots 1 et 2 : implémentés.** Calendrier central ajouté et date affichée à la place du temps écoulé ; compte à rebours conservé séparément pour les parties limitées. Réglage initial : 1er janvier de l'an 1, 10 ticks par jour, années de 365 jours. Les trêves, NAP et casus belli affichent maintenant leur date d'échéance fictive.

Objectif jouable : remplacer le chronomètre principal par une date fictive et laisser le temps de prendre des décisions.

Lots :

1. Définir une conversion centrale entre ticks et calendrier, puis afficher la date.
2. Afficher les échéances diplomatiques dans ce calendrier et expliquer la durée restante.
3. Vérifier les vitesses existantes et la pause ; ajouter une vitesse plus lente seulement si nécessaire.
4. Ajuster séparément le rythme des guerres et des décisions diplomatiques après essais.

Propositions à régler, pas encore décisions définitives : début au 1er janvier de l'an 1 ; 1 seconde de simulation pour 1 jour ; vitesse ×0,25 éventuelle. Une simple conversion d'affichage ne change pas automatiquement l'équilibrage : les durées des trêves et autres accords seront examinées explicitement.

À tester : progression des dates, changements de mois et d'année, pause, changements de vitesse, concordance des échéances avec leur expiration réelle dans la simulation. Aucun bouton de vitesse ne doit accélérer seulement certains systèmes.

Critère de sortie : une horloge de simulation commune et des durées compréhensibles, sans régression des trêves.

### 2. Relations, intérêts et interface de décision

**Fondation implémentée, vérifiée techniquement.** Opinion chiffrée, confiance, menace perçue et mémoire bornée à 24 événements par pays. Les signatures et ruptures de NAP, garanties, guerres et paix alimentent cette mémoire. Diplomacy+ affiche la relation du pays sélectionné envers le joueur. Ces données sont structurées pour l'IA classique et le futur adaptateur LLM.

Objectif jouable : comprendre pourquoi un pays coopère, refuse ou devient hostile.

Lots :

1. Distinguer relations, confiance et menace perçue, avec facteurs visibles dans l'interface.
2. Définir les intérêts nationaux : sécurité, territoires revendiqués, accès aux ressources, partenaires.
3. Ajouter une mémoire structurée des événements importants : guerre, aide, engagements tenus ou rompus.
4. Faire influencer les décisions par le profil du dirigeant ou du gouvernement.
5. Centraliser les actions politiques disponibles et leur validation pour le joueur, l'IA classique et le futur LLM.

À tester : les réactions ont une cause visible ; une seule action ne produit pas plusieurs fois sa récompense ou sa pénalité ; les valeurs restent bornées ; les relations peuvent être asymétriques ; changer de dirigeant n'efface pas les obligations du pays.

Critère de sortie : les décisions de l'IA s'appuient sur les mêmes données et règles que les interactions du joueur. Les dirigeants nommés et leur succession complète restent pour plus tard.

### 3. Économie de base

**Premier lot implémenté, vérifié techniquement.** Les stocks ont désormais une consommation par minute fondée sur le territoire, les troupes, les unités et les offensives. Diplomacy+ affiche le bilan net. Les stocks restent bornés et une pénurie alimentaire prolongée entraîne une attrition lente. L'équilibrage reste à valider en partie.

Objectif jouable : donner un usage aux ressources et créer des besoins d'échange.

Lots :

1. Définir les stocks, la production, la consommation et les usages de nourriture, matériaux et carburant.
2. Afficher un bilan prévisionnel : surplus, déficit et autonomie.
3. Introduire progressivement les effets des pénuries, avec avertissements compréhensibles.
4. Définir le moyen de paiement du commerce et son lien avec l'or existant.

À tester : cohérence des bilans, changement de propriétaire d'une région, pénuries prolongées, absence de duplication et absence de stocks négatifs involontaires. La vitesse de jeu ne doit pas modifier les ratios économiques.

Critère de sortie : chaque pays a des besoins lisibles ; les premières minutes restent jouables sur plusieurs cartes.

### 4. Commerce pour tous — premier grand système économique

**Premier système complet implémenté, vérifié techniquement.** Le joueur peut proposer des importations ou exportations paramétrées (ressource, quantité, prix et nombre de livraisons). Les nations évaluuent les offres selon leurs réserves, leurs besoins, le prix et la confiance. Les contrats récurrents sont visibles et annulables, réservent les engagements lors de l'acceptation, revalident fonds, stocks, partenaire et embargo à chaque livraison, puis conservent leur état final comme historique. Les nations peuvent aussi initier des échanges entre elles. Les acceptations, refus, achèvements et ruptures produisent désormais une notification explicite. L'équilibrage des prix et fréquences reste à tester en partie.

Objectif jouable : permettre au joueur et à chaque nation d'acheter et de vendre.

Lots :

1. Échanges bilatéraux simples : ressource, quantité, prix, acceptation ou refus explicable.
2. Vérifier les fonds et stocks au moment de l'exécution ; réserver les engagements lorsque nécessaire.
3. Ajouter des contrats récurrents, une durée, une annulation et un historique.
4. Faire proposer et accepter des échanges aux IA selon leurs besoins et intérêts.
5. Faire apparaître les dépendances commerciales dans la diplomatie.

Le marché mondial et les routes physiques de livraison sont des extensions possibles ; le premier lot doit fonctionner sans eux.

À tester : offres simultanées sur le même stock, fonds insuffisants, double acceptation, fin de contrat, disparition d'un partenaire et changement de relations. Aucun échange ne crée gratuitement de ressources ou de monnaie.

Critère de sortie : une partie où le joueur et plusieurs IA commercent réellement, avec des comptes cohérents et des refus compréhensibles.

### 5. Coopération internationale

**Première version implémentée, vérifiée techniquement.** Aide économique avec délai anti-abus, accords commerciaux préférentiels, garanties, alliances défensives existantes et projets communs payés par les deux partenaires. Les effets alimentent opinion, confiance et mémoire.

Objectif jouable : faire de la coopération une stratégie durable.

Lots : aide économique, accords commerciaux préférentiels, amélioration des garanties existantes, pactes défensifs, puis projets communs.

À tester : obligations explicites, engagements honorés, coûts effectivement payés, limites à l'aide répétée et absence de gains de confiance exploitables par échanges circulaires.

Critère de sortie : plusieurs pays peuvent poursuivre un intérêt commun sans fusionner ni perdre leurs propres objectifs.

### 6. Tensions et crises

**Chaîne des incidents maritimes implémentée, vérifiée techniquement.** Les ultimatums ouvrent une crise partagée avec réponse différée et échéance. La saisie ou la destruction d'un navire commercial crée un incident persistant et confirmé, visible dans Diplomatie. Protestation, abandon, restitution, excuses, réparation, refus, contre-proposition, médiation, sanctions et ultimatum passent par les règles communes. Le refus final peut accorder un casus belli sans déclencher automatiquement une guerre. Une trêve interdit l'ouverture d'une crise et neutralise aussi les armes spéciales visant le signataire.

Objectif jouable : permettre une escalade diplomatique avant la guerre, et une issue pacifique.

Lots restants : brancher les violations territoriales et de traité sur le même registre, puis équilibrer les seuils et délais après essais en partie.

À tester : motifs valides, délais respectés, conséquences commerciales réelles, refus et acceptation traités une seule fois. Une crise ne contourne pas une trêve.

Critère de sortie : une même crise peut se résoudre par accord, rester bloquée ou conduire à une guerre selon les décisions prises.

### 7. Logistique militaire et paix négociée

**Paix régionale V1 implémentée, vérifiée techniquement.** Une offensive consomme un ravitaillement initial plafonné ; les armées, offensives et navires entretiennent une consommation continue. Les pénuries alimentaires touchent les troupes et le manque de carburant use les offensives. Les structures exigent des matériaux. Paix blanche, réparations, levée d'embargo et cession d'une région historique peuvent être réunies dans une proposition atomique. Le transfert déplace les structures sans les compter comme prises de guerre, respecte les contrôles tiers et efface l'objectif de guerre régional correspondant. La V1 protège le noyau fondateur, l'élimination totale et le dernier territoire viable ; ces protections restent des règles de cette version, pas des invariants définitifs du moteur.

Objectif jouable : rendre la guerre dépendante de l'économie et donner du contenu aux traités de paix.

Lots :

1. Consommation militaire et approvisionnement, en utilisant l'économie déjà testée.
2. Usure et coût de guerre ; ralentissement progressif plutôt qu'effondrement incompréhensible.
3. Négociation : paix blanche, reconnaissance du contrôle, cession ou restitution de territoires.
4. Réparations, engagements de paiement et durée des trêves.

À tester : pénuries, attaques multiples, régions partagées, conflits simultanés, territoires contrôlés par des tiers, transferts après traité et application bilatérale de la paix.

Critère de sortie : le joueur comprend ce qu'une guerre lui coûte, ce qu'il peut obtenir et pourquoi un adversaire accepte ou refuse.

### 8. Politique intérieure et dirigeants

**Première version avec factions implémentée, vérifiée techniquement.** Cinq niveaux de fiscalité, stabilité et satisfaction évoluent selon les pénuries, la guerre et les impôts. Les gouvernements ont un profil, un mandat et une succession ; les obligations et la mémoire restent celles du pays. Militaires, marchands, diplomates, isolationnistes et expansionnistes ont une influence normalisée, une tendance et une raison visibles. Leur poids intervient dans l'évaluation des pactes, du commerce, des excuses et de la paix territoriale.

Objectif jouable : relier les choix extérieurs à la situation intérieure.

Lots progressifs : budget, fiscalité, stabilité, satisfaction de la population, orientations du gouvernement, puis succession des dirigeants.

À tester : conséquences visibles et proportionnées, possibilité de redressement, continuité des traités et de la mémoire nationale lors d'une succession.

Critère de sortie : les changements de politique apportent de nouveaux choix sans rendre les systèmes précédents illisibles.

### 9. Pilotage politique par LLM — module optionnel

**Passerelle moteur étendue, sans fournisseur externe.** Un instantané synthétique expose économie, relations, intérêts, factions, agenda, mémoire, contrats, crises, incidents et propositions. Les décisions utilisent une union structurée, sont revalidées et sont converties en exécutions ordinaires. Une décision peut maintenant soumettre les mêmes termes diplomatiques que le joueur, y compris une paix régionale, sans modifier directement le monde. Le branchement réseau, le budget d'appels et le journal d'un fournisseur LLM restent optionnels et désactivés.

Fondations prévues dès l'étape 2. Un prototype limité peut être réalisé plus tôt une fois les actions et les données suffisamment stables ; il ne doit pas bloquer les autres étapes.

Lots :

1. Fournir un état synthétique du pays, ses objectifs, sa mémoire et ses actions autorisées.
2. Demander des décisions structurées lors de bilans politiques ou d'événements importants, pas à chaque tick.
3. Vérifier chaque action dans le moteur de jeu avant application.
4. Revalider la situation lorsqu'une réponse arrive en retard.
5. Prévoir délais maximaux, budget d'appels, journal des décisions et relais par l'IA classique.
6. Étendre progressivement de quelques nations pilotes à davantage de pays.

À tester : réponse invalide, action impossible, service indisponible, coût excessif, réponse tardive et tentatives de contourner les règles par le texte diplomatique. Aucune réponse ne modifie directement les stocks, les frontières ou les traités hors des actions validées.

Critère de sortie : une nation pilotée par LLM a une politique suivie et compréhensible, tandis que le jeu continue normalement sans accès au modèle.

### 10. Organisation internationale

**Première boucle joueur implémentée, vérifiée techniquement.** Un registre séparé possède les organisations, leur charte, leurs membres, les résolutions et les votes. Une fondation exige au moins trois pays. Les premières résolutions couvrent la condamnation, la demande de réparations, les sanctions collectives et les candidatures. Le quorum, le résultat et les motivations des votes sont déterministes. Une résolution adoptée modifie la réputation et la mémoire diplomatique ; les sanctions sont appliquées uniquement par les pays ayant voté pour. Une demande de réparations adoptée ouvre une proposition bilatérale ordinaire, qui reste soumise à validation et peut encore être acceptée ou refusée. L'état international est maintenant synchronisé vers le client par instantanés versionnés. Le menu permanent permet de fonder une organisation, demander une adhésion soumise au vote, soumettre une condamnation ou des sanctions et voter. Ces ordres passent par le transport réseau normal et sont applicables pendant la pause sans avancer la date.

Lots suivants : sélection libre des cofondateurs et principes de charte, interface de demande de réparations fondée sur un incident, possibilité d'ignorer une résolution avec coût politique, puis casus belli `Enforce Resolution`.

À tester : coalition minimale, double vote, quorum, abstention, disparition d'un membre, incident devenu caduc et absence de double application.

## Règles transversales

- Les mécaniques dépendent du monde généré et des données de la carte, pas de noms de pays imposés.
- Les régions historiques conservent un centre intérieur calculé depuis leur géométrie ; leurs noms et frontières deviennent progressivement plus lisibles avec le zoom sans encombrer la vue mondiale.
- Les ressources, paiements et transferts sont vérifiés par le moteur ; l'interface ne suffit pas à faire respecter une règle.
- Les actions concurrentes doivent être revalidées au moment de leur exécution.
- La mémoire conserve les événements utiles sans grossir indéfiniment.
- Les explications diplomatiques doivent correspondre aux causes réellement utilisées dans les décisions.
- Les demandes diplomatiques et leurs résultats doivent produire une notification dédupliquée sans obliger le joueur à garder un menu ouvert.
- La stabilité et la lisibilité priment sur l'ajout simultané de nombreuses mécaniques.
- Sauvegarde/reprise de campagne : besoin à étudier avant les longues parties ; ne pas considérer cette capacité comme déjà acquise.

## Correctif intermédiaire — pause active

Demandé après validation du calendrier. Les ordres solo sont transmis pendant la pause sans avancer les ticks. Les attaques sont engagées et les décisions unilatérales prises immédiatement ; les réponses aux NAP et ultimatums attendent la reprise. Les trêves restent obligatoires. Les nouvelles demandes identiques en attente sont dédupliquées. À tester en partie avant de continuer les échéances diplomatiques.

## Prochain lot concret

Valider en partie deux scénarios complets : l'incident maritime jusqu'à sa résolution ou son ultimatum, puis une paix comprenant la cession d'une région historique. Tester ensuite la nouvelle boucle internationale : fondation à trois pays, résolution contre un pays sélectionné, votes pendant la pause, reprise du temps et application unique du résultat. Le prochain lot moteur est l'adhésion négociée et le coût politique du refus d'une résolution.
