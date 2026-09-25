import { within } from "../Util";
import {
  Game,
  isDiplomacyPlusParticipant,
  NationalAgenda,
  NationalAgendaGoal,
  NationalConcern,
  NationalConcernType,
  NationalGoalType,
  Player,
  Relation,
  StrategicRegionInterest,
  StrategicResource,
  UnitType,
} from "./Game";

const AGENDA_MIN_LIFETIME = 600;
const AGENDA_GOAL_LIFETIME = 3600;

type GoalCandidate = Omit<NationalAgendaGoal, "id" | "createdAt" | "expiresAt">;

function concernKey(concern: NationalConcern): string {
  return [
    concern.type,
    concern.resource ?? "",
    concern.targetID ?? "",
    concern.regionID ?? "",
  ].join(":");
}

function goalKey(goal: GoalCandidate | NationalAgendaGoal): string {
  return [
    goal.type,
    goal.resource ?? "",
    goal.targetID ?? "",
    goal.regionID ?? "",
  ].join(":");
}

function concern(
  now: number,
  previous: Map<string, NationalConcern>,
  value: Omit<NationalConcern, "since" | "lastEvaluatedAt">,
): NationalConcern {
  const key = concernKey({
    ...value,
    since: now,
    lastEvaluatedAt: now,
  });
  return {
    ...value,
    since: previous.get(key)?.since ?? now,
    lastEvaluatedAt: now,
  };
}

function hasCoast(game: Game, player: Player): boolean {
  const neighbors: number[] = [0, 0, 0, 0];
  for (const tile of player.borderTiles()) {
    const count = game.map().neighbors4(tile, neighbors);
    for (let i = 0; i < count; i++) {
      if (game.isWater(neighbors[i])) return true;
    }
  }
  return false;
}

function resourceConcernType(resource: StrategicResource): NationalConcernType {
  if (resource === "food") return "food_insecurity";
  if (resource === "fuel") return "fuel_shortage";
  return "materials_shortage";
}

function resourceGoalType(resource: StrategicResource): NationalGoalType {
  if (resource === "food") return "secure_food_supply";
  if (resource === "fuel") return "secure_fuel_supply";
  return "build_material_reserves";
}

export function buildNationalAgenda(
  game: Game,
  player: Player,
  previous?: NationalAgenda,
): NationalAgenda {
  const now = game.ticks();
  const previousConcerns = new Map(
    (previous?.concerns ?? []).map((item) => [concernKey(item), item]),
  );
  const countries = game
    .players()
    .filter(
      (other) =>
        other !== player &&
        other.isAlive() &&
        isDiplomacyPlusParticipant(other),
    );
  const nearby = new Set(
    player
      .nearby()
      .filter(
        (other): other is Player =>
          other.isPlayer() && isDiplomacyPlusParticipant(other),
      ),
  );
  const production = game.resourceProduction(player);
  const consumption = player.resourceConsumption();
  const stocks = player.resources();
  const concerns: NationalConcern[] = [];

  const resourcePressure = (["food", "materials", "fuel"] as const)
    .map((resource) => {
      const use = Math.max(0.1, consumption[resource]);
      const balance = production[resource] - use;
      const reserve = stocks[resource] / use;
      const severity = within(
        Math.round(
          Math.max(0, -balance / use) * 55 + Math.max(0, 30 - reserve) * 1.5,
        ),
        0,
        100,
      );
      return { resource, balance, reserve, severity };
    })
    .sort((a, b) => b.severity - a.severity);

  for (const pressure of resourcePressure) {
    if (pressure.severity < 20) continue;
    concerns.push(
      concern(now, previousConcerns, {
        type: resourceConcernType(pressure.resource),
        severity: pressure.severity,
        resource: pressure.resource,
        reason: `${pressure.resource}: réserve ${Math.round(pressure.reserve)} mois, solde ${pressure.balance.toFixed(1)}/mois`,
      }),
    );
  }

  const strongestNeighbour = [...nearby]
    .filter((other) => !player.isFriendly(other))
    .sort(
      (a, b) =>
        b.troops() +
        b.numTilesOwned() * 20 -
        (a.troops() + a.numTilesOwned() * 20),
    )[0];
  if (strongestNeighbour !== undefined) {
    const ownPower = Math.max(1, player.troops() + player.numTilesOwned() * 20);
    const otherPower =
      strongestNeighbour.troops() + strongestNeighbour.numTilesOwned() * 20;
    const ratio = otherPower / ownPower;
    const perceived = player.perceivedThreat(strongestNeighbour, true);
    if (ratio >= 1.2 || perceived >= 50) {
      concerns.push(
        concern(now, previousConcerns, {
          type: "powerful_neighbour",
          targetID: strongestNeighbour.id(),
          severity: within(
            Math.round((ratio - 1) * 45 + perceived * 0.6),
            20,
            100,
          ),
          reason: `${strongestNeighbour.displayName()} dispose d'une puissance relative de ${ratio.toFixed(1)}×`,
        }),
      );
    }
    if (
      ratio >= 1.35 ||
      player.troops() < game.config().maxTroops(player) * 0.35
    ) {
      concerns.push(
        concern(now, previousConcerns, {
          type: "military_vulnerability",
          targetID: strongestNeighbour.id(),
          severity: within(Math.round((ratio - 1) * 55 + 35), 25, 100),
          reason: `Les forces disponibles sont insuffisantes face à ${strongestNeighbour.displayName()}`,
        }),
      );
    }
  }

  const activeImports = player
    .tradeContracts()
    .filter(
      (contract) =>
        contract.status === "active" && contract.buyerID === player.id(),
    );
  if (activeImports.length > 0 && resourcePressure[0].balance < 0) {
    concerns.push(
      concern(now, previousConcerns, {
        type: "commercial_dependence",
        resource: resourcePressure[0].resource,
        severity: within(35 + activeImports.length * 12, 0, 100),
        reason: `${activeImports.length} importation(s) active(s) compensent une production insuffisante`,
      }),
    );
  }

  const hasPort = player.unitCount(UnitType.Port) > 0;
  const hasMaritimeActivity =
    hasPort || activeImports.length > 0 || player.tradeContracts().length > 0;
  if (hasMaritimeActivity && player.unitCount(UnitType.Warship) === 0) {
    concerns.push(
      concern(now, previousConcerns, {
        type: "naval_vulnerability",
        severity: hasPort ? 55 : 35,
        reason: "Le commerce maritime ne dispose d'aucune protection navale",
      }),
    );
  }
  if (!hasPort && player.numTilesOwned() >= 100 && hasCoast(game, player)) {
    concerns.push(
      concern(now, previousConcerns, {
        type: "strategic_port_needed",
        severity: 45,
        reason: "Le pays possède un littoral mais aucun port opérationnel",
      }),
    );
  }

  const activeTreaties =
    player.alliances().length +
    countries.filter(
      (other) =>
        player.nonAggressionPactWith(other) !== null ||
        player.tradeAgreementWith(other) !== null,
    ).length;
  if (countries.length >= 2 && activeTreaties === 0) {
    concerns.push(
      concern(now, previousConcerns, {
        type: "diplomatic_isolation",
        severity: within(35 + countries.length, 0, 70),
        reason: "Aucune alliance, pacte ou relation commerciale privilégiée",
      }),
    );
  }

  const memories = player.diplomaticMemories();
  const lostTerritory = memories
    .filter((memory) => memory.type === "territory_lost")
    .sort((a, b) => b.severity - a.severity)[0];
  if (lostTerritory !== undefined) {
    concerns.push(
      concern(now, previousConcerns, {
        type: "lost_territory",
        targetID: lostTerritory.otherID,
        regionID: lostTerritory.regionID,
        severity: lostTerritory.severity,
        reason: "Une région historique a été perdue lors d'un conflit récent",
      }),
    );
  }
  const tradeThreat = memories
    .filter(
      (memory) =>
        memory.type === "trade_ship_seized" ||
        memory.type === "trade_ship_destroyed",
    )
    .sort((a, b) => b.severity - a.severity)[0];
  if (tradeThreat !== undefined) {
    concerns.push(
      concern(now, previousConcerns, {
        type: "trade_route_threatened",
        targetID: tradeThreat.otherID,
        severity: tradeThreat.severity,
        reason:
          "Des pertes commerciales récentes menacent les routes maritimes",
      }),
    );
  }

  const atWar =
    player.outgoingAttacks().some((attack) => attack.target().isPlayer()) ||
    player
      .incomingAttacks()
      .some((attack) => isDiplomacyPlusParticipant(attack.attacker()));
  if (
    atWar &&
    (player.publicSatisfaction() < 45 ||
      stocks.food <= consumption.food * 10 ||
      stocks.fuel <= consumption.fuel * 10)
  ) {
    concerns.push(
      concern(now, previousConcerns, {
        type: "high_war_exhaustion",
        severity: within(
          Math.round(
            70 - player.publicSatisfaction() + (stocks.food <= 0 ? 25 : 0),
          ),
          30,
          100,
        ),
        reason: "La guerre pèse sur les réserves et la satisfaction publique",
      }),
    );
  }

  concerns.sort(
    (a, b) => b.severity - a.severity || a.type.localeCompare(b.type),
  );

  const rivals = countries
    .map((other) => ({
      id: other.id(),
      score:
        player.perceivedThreat(other, nearby.has(other)) +
        Math.max(0, -player.relationScore(other)) * 0.45 +
        player.grievanceScore(other) * 0.65 +
        (nearby.has(other) ? 15 : 0),
    }))
    .filter((entry) => entry.score >= 50)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((entry) => entry.id);

  const preferredPartners = countries
    .filter(
      (other) =>
        !rivals.includes(other.id()) &&
        player.relation(other) !== Relation.Hostile &&
        player.canTrade(other),
    )
    .map((other) => ({
      id: other.id(),
      score:
        player.trust(other) +
        player.relationScore(other) * 0.4 +
        (player.isFriendly(other) ? 30 : 0) +
        (player.tradeAgreementWith(other) !== null ? 20 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((entry) => entry.id);

  const regionScores = new Map<number, StrategicRegionInterest>();
  const addRegion = (entry: StrategicRegionInterest) => {
    const old = regionScores.get(entry.regionID);
    if (old === undefined || entry.priority > old.priority) {
      regionScores.set(entry.regionID, entry);
    }
  };
  for (const war of countries) {
    const regionID = player.warGoalRegionAgainst(war);
    if (regionID !== null) {
      addRegion({
        regionID,
        priority: 100,
        reason: `Objectif territorial actif contre ${war.displayName()}`,
      });
    }
  }
  for (const region of game.historicalRegions()) {
    const owned = game.historicalRegionOwnedTiles(region.id, player);
    if (owned <= 0) continue;
    const share = owned / Math.max(1, region.tileCount);
    const neededResourceBonus =
      resourcePressure[0].resource === "food"
        ? region.resources.food
        : resourcePressure[0].resource === "fuel"
          ? region.resources.fuel * 2
          : region.resources.materials;
    addRegion({
      regionID: region.id,
      priority: within(
        Math.round(share * 55 + neededResourceBonus + (share < 0.8 ? 25 : 0)),
        1,
        95,
      ),
      reason:
        share < 0.8
          ? `Région historique disputée (${Math.round(share * 100)}% contrôlés)`
          : `Région importante pour la production de ${resourcePressure[0].resource}`,
    });
  }
  if (lostTerritory?.regionID !== undefined) {
    addRegion({
      regionID: lostTerritory.regionID,
      priority: 95,
      reason: "Territoire historique perdu",
    });
  }
  const strategicRegions = [...regionScores.values()]
    .sort((a, b) => b.priority - a.priority || a.regionID - b.regionID)
    .slice(0, 4);

  const candidates: GoalCandidate[] = [];
  const strongestResourceConcern = concerns.find((item) => item.resource);
  if (strongestResourceConcern?.resource !== undefined) {
    candidates.push({
      type: resourceGoalType(strongestResourceConcern.resource),
      priority: strongestResourceConcern.severity + 10,
      resource: strongestResourceConcern.resource,
      reason: strongestResourceConcern.reason,
    });
    if (preferredPartners.length > 0) {
      candidates.push({
        type: "find_trade_partner",
        priority: strongestResourceConcern.severity + 5,
        resource: strongestResourceConcern.resource,
        targetID: preferredPartners[0],
        reason: `Le commerce est la première réponse au besoin de ${strongestResourceConcern.resource}`,
      });
    }
  }
  for (const item of concerns) {
    if (item.type === "powerful_neighbour")
      candidates.push({
        type: "contain_rival",
        priority: item.severity,
        targetID: item.targetID,
        reason: item.reason,
      });
    if (item.type === "military_vulnerability")
      candidates.push({
        type: "secure_border",
        priority: item.severity,
        targetID: item.targetID,
        reason: item.reason,
      });
    if (
      item.type === "naval_vulnerability" ||
      item.type === "trade_route_threatened"
    )
      candidates.push({
        type: "protect_maritime_trade",
        priority: item.severity,
        targetID: item.targetID,
        reason: item.reason,
      });
    if (item.type === "strategic_port_needed")
      candidates.push({
        type: "obtain_port",
        priority: item.severity,
        reason: item.reason,
      });
    if (item.type === "diplomatic_isolation")
      candidates.push({
        type: "strengthen_alliance",
        priority: item.severity,
        targetID: preferredPartners[0],
        reason: item.reason,
      });
    if (item.type === "commercial_dependence")
      candidates.push({
        type: "reduce_economic_dependence",
        priority: item.severity,
        resource: item.resource,
        reason: item.reason,
      });
    if (item.type === "lost_territory")
      candidates.push({
        type: "recover_lost_territory",
        priority: item.severity,
        targetID: item.targetID,
        regionID: item.regionID,
        reason: item.reason,
      });
    if (item.type === "high_war_exhaustion")
      candidates.push({
        type: "avoid_costly_war",
        priority: item.severity + 15,
        reason: item.reason,
      });
  }
  if (strategicRegions[0] !== undefined && strategicRegions[0].priority >= 70) {
    candidates.push({
      type: "control_strategic_region",
      priority: strategicRegions[0].priority,
      regionID: strategicRegions[0].regionID,
      reason: strategicRegions[0].reason,
    });
  }
  if (candidates.length < 2) {
    candidates.push({
      type: "build_national_reserves",
      priority: 35,
      reason: "Constituer une marge économique avant la prochaine crise",
    });
  }
  if (candidates.length < 2) {
    candidates.push({
      type: "secure_border",
      priority: 30,
      reason: "Maintenir une frontière stable et défendable",
    });
  }

  const style = player.governmentProfile().style;
  for (const candidate of candidates) {
    if (
      style === "hawkish" &&
      (candidate.type === "contain_rival" ||
        candidate.type === "recover_lost_territory")
    )
      candidate.priority += 12;
    if (
      style === "cooperative" &&
      (candidate.type === "find_trade_partner" ||
        candidate.type === "strengthen_alliance")
    )
      candidate.priority += 12;
    if (
      style === "cautious" &&
      (candidate.type === "secure_border" ||
        candidate.type === "avoid_costly_war")
    )
      candidate.priority += 12;
  }

  const previousGoals = new Map(
    (previous?.goals ?? []).map((goal) => [goalKey(goal), goal]),
  );
  const uniqueCandidates = new Map<string, GoalCandidate>();
  for (const candidate of candidates) {
    candidate.priority = within(Math.round(candidate.priority), 0, 100);
    const key = goalKey(candidate);
    const old = uniqueCandidates.get(key);
    if (old === undefined || candidate.priority > old.priority)
      uniqueCandidates.set(key, candidate);
  }
  for (const old of previous?.goals ?? []) {
    if (
      now < old.createdAt + AGENDA_MIN_LIFETIME &&
      !uniqueCandidates.has(goalKey(old))
    ) {
      uniqueCandidates.set(goalKey(old), {
        type: old.type,
        priority: Math.max(1, old.priority - 10),
        reason: old.reason,
        resource: old.resource,
        targetID: old.targetID,
        regionID: old.regionID,
      });
    }
  }
  const goals = [...uniqueCandidates.values()]
    .sort(
      (a, b) => b.priority - a.priority || goalKey(a).localeCompare(goalKey(b)),
    )
    .slice(0, 4)
    .map((candidate) => {
      const key = goalKey(candidate);
      const old = previousGoals.get(key);
      return {
        ...candidate,
        id: `${player.id()}:${key}`,
        createdAt: old?.createdAt ?? now,
        expiresAt:
          old !== undefined && old.expiresAt > now
            ? old.expiresAt
            : now + AGENDA_GOAL_LIFETIME,
      };
    });

  return {
    generatedAt: now,
    reevaluateAt: now + 900 + (player.smallID() % 301),
    goals,
    concerns,
    strategicRegions,
    rivals,
    preferredPartners,
  };
}
