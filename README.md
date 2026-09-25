<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="proprietary/images/OpenFrontLogoDark.svg">
    <source media="(prefers-color-scheme: light)" srcset="proprietary/images/OpenFrontLogo.svg">
    <img src="proprietary/images/OpenFrontLogo.svg" alt="OpenFront Diplomacy+" width="320">
  </picture>
</p>

<h1 align="center">OpenFront — Diplomacy+</h1>

<p align="center">
  Un mod géopolitique pour OpenFront, inspiré par Europa Universalis IV et Geopolitical Simulator.
</p>

<p align="center">
  <img alt="État du projet" src="https://img.shields.io/badge/%C3%A9tat-prototype%20jouable-d6a84b">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.x-3178c6">
  <a href="LICENSE"><img alt="Licence AGPL v3" src="https://img.shields.io/badge/licence-AGPL%20v3-blue"></a>
</p>

> [!IMPORTANT]
> Diplomacy+ est un projet communautaire non officiel. Il n'est ni développé, ni approuvé, ni maintenu par l'équipe officielle d'OpenFront.

## Présentation

Diplomacy+ transforme la partie solo d'OpenFront en bac à sable géopolitique. Les pays disposent d'intérêts nationaux, d'une mémoire diplomatique, d'une économie stratégique et d'objectifs de guerre territoriaux. Le joueur dirige son pays depuis un conseil d'État inspiré des jeux de grande stratégie.

Le mod reste compatible avec les différentes cartes d'OpenFront : les systèmes politiques sont attachés aux nations et aux villes, pas à une carte précise.

## Fonctionnalités actuelles

- menu permanent **🏛 Gestion** avec les onglets Pays, Fiscalité, Armées, Diplomatie, Commerce, Crises et Gouvernement ;
- calendrier fictif et vitesses de jeu adaptées aux parties longues ;
- ordres diplomatiques utilisables pendant la pause, avec réponses traitées lorsque le temps reprend ;
- opinions, confiance, menace, réputation et mémoire diplomatique ;
- pactes de non-agression, garanties, alliances, embargos et crises internationales ;
- commerce bilatéral de nourriture, matériaux et carburant ;
- fiscalité à cinq niveaux, stabilité et satisfaction publique ;
- objectifs de guerre régionaux et contrôle des régions historiques ;
- armée fondée sur le vivier national d'OpenFront ;
- potentiel humain principalement fourni par les villes ;
- capacité militaire et vitesse de mobilisation améliorées par les postes de défense ;
- curseur de mobilisation nationale de 0 à 100 % ;
- comportement politique déterministe des nations et interface prête pour un futur pilote LLM.

La [roadmap détaillée](DIPLOMACY_ROADMAP.md) décrit les systèmes terminés, ceux à équilibrer et les prochaines étapes.

## Installation pour développer

Prérequis : Node.js, npm 10.9.2 ou plus récent et une copie d'OpenFront sur Steam.

```powershell
git clone https://github.com/waffle913/OpenFront-Diplomacy-Plus.git
cd OpenFront-Diplomacy-Plus
npm run inst
npm run build-prod
```

Le build de production est créé dans `static/`. Pour tester manuellement sur la version Steam actuelle, fermez complètement OpenFront puis copiez le contenu de `static/` dans :

```text
C:\Program Files (x86)\Steam\steamapps\common\OpenFront\resources\renderer
```

Le client Steam possède un système de mise à jour interne qui peut prendre la priorité sur ce dossier. L'installateur local automatisé et une archive prête à jouer seront ajoutés dans une prochaine version. Pour le moment, l'installation Steam est destinée aux développeurs capables de sauvegarder et restaurer `resources/app.asar` et `resources/renderer`.

## Lancer les tests

```powershell
npx tsc --noEmit
npx vitest run tests/PoliticalSystems.test.ts tests/TradeContracts.test.ts tests/DiplomacyRegional.test.ts tests/client/DiplomacyPanel.test.ts tests/client/LocalServerSpeed.test.ts
```

Le benchmark de référence utilise :

```powershell
npx tsx tests/perf/fullgame/FullGamePerf.ts
```

## Organisation du projet

- `src/core` — simulation, économie, diplomatie, guerre et mobilisation ;
- `src/client/hud/layers/DiplomacyPanel.ts` — conseil d'État et menus de gestion ;
- `src/core/execution/PoliticalDecisionAdapter.ts` — frontière entre décisions politiques et simulation, prévue pour accueillir un adaptateur LLM ;
- `tests` — tests déterministes des nouveaux systèmes ;
- `DIPLOMACY_ROADMAP.md` — feuille de route et protocole de test en partie.

## Crédits et licences

Diplomacy+ est basé sur [OpenFrontIO](https://github.com/openfrontio/OpenFrontIO), lui-même issu de WarFront.io. Merci aux équipes et contributeurs de ces projets.

Le code source reste sous **GNU Affero General Public License v3.0**. Les avis de copyright visibles d'OpenFront doivent être conservés. Consultez [LICENSE](LICENSE) et [LICENSING.md](LICENSING.md).

Les ressources ont leurs propres conditions, détaillées dans [LICENSE-ASSETS](LICENSE-ASSETS). Toute redistribution doit les respecter.

## État du projet

Cette version est une candidate de test. Les systèmes sont jouables et couverts par des tests ciblés, mais l'équilibrage économique, militaire et diplomatique doit encore être validé sur des parties longues. Les rapports de bugs et les cas de contournement des règles sont particulièrement utiles.
