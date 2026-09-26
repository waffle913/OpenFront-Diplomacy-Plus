import type { PlayerState } from "../../client/render/types";
import type { EmojiMessage } from "./Game";
import {
  AllianceView,
  AttackUpdate,
  GameUpdateType,
  PlayerUpdate,
} from "./GameUpdates";

/**
 * Build a partial PlayerUpdate containing only fields whose value differs
 * between `prev` and `next`. Returns null if nothing changed.
 *
 * `type` and `id` are always included on the returned diff. Array/object
 * fields are compared by structural equality (length + per-element);
 * `embargoes` is compared as a set; primitive fields by `===`.
 *
 * WARNING: this diff is field-by-field by design (no JSON.stringify, for
 * perf — see tests/perf/DiffPlayerUpdatePerf.ts). When you add a field to
 * PlayerUpdate, you MUST add a matching setIfDifferent(...) line here, and an
 * apply line in applyStateUpdate below. A field missing here is never diffed,
 * so its changes silently never reach the main thread after the first update.
 *
 * EXCEPTION: tilesOwned / gold / troops / goldEarned are deliberately NOT
 * diffed here. They change for nearly every alive player every tick, so they
 * travel on the transferable `GameUpdateViewData.packedPlayerUpdates` channel
 * instead (see PlayerImpl.toUpdate) and appear in PlayerUpdate objects only on
 * a player's first (full) emission.
 */
export function diffPlayerUpdate(
  prev: PlayerUpdate,
  next: PlayerUpdate,
): PlayerUpdate | null {
  // Fast path: this runs for every player every tick and usually finds no
  // changes (tilesOwned/gold/troops travel separately) — return without
  // allocating anything. The comparisons repeat below only for the rare
  // changed player.
  if (
    prev.clientID === next.clientID &&
    prev.name === next.name &&
    prev.displayName === next.displayName &&
    prev.clanTag === next.clanTag &&
    prev.nationFlag === next.nationFlag &&
    prev.team === next.team &&
    prev.smallID === next.smallID &&
    prev.playerType === next.playerType &&
    prev.isAlive === next.isAlive &&
    prev.isDisconnected === next.isDisconnected &&
    prev.killedBy === next.killedBy &&
    prev.deathPosition === next.deathPosition &&
    prev.tradeGold === next.tradeGold &&
    prev.trainGold === next.trainGold &&
    prev.piracyGold === next.piracyGold &&
    prev.food === next.food &&
    prev.materials === next.materials &&
    prev.fuel === next.fuel &&
    prev.foodProduction === next.foodProduction &&
    prev.materialsProduction === next.materialsProduction &&
    prev.fuelProduction === next.fuelProduction &&
    prev.foodConsumption === next.foodConsumption &&
    prev.materialsConsumption === next.materialsConsumption &&
    prev.fuelConsumption === next.fuelConsumption &&
    shortageEqual(prev.resourceShortages, next.resourceShortages) &&
    prev.isTraitor === next.isTraitor &&
    prev.traitorRemainingTicks === next.traitorRemainingTicks &&
    prev.inDoomsdayClock === next.inDoomsdayClock &&
    prev.markedDoomsdayClockTick === next.markedDoomsdayClockTick &&
    prev.isDecaying === next.isDecaying &&
    prev.hasSpawned === next.hasSpawned &&
    prev.spawnTile === next.spawnTile &&
    prev.betrayals === next.betrayals &&
    prev.threat === next.threat &&
    prev.reputation === next.reputation &&
    prev.stability === next.stability &&
    prev.publicSatisfaction === next.publicSatisfaction &&
    prev.taxPolicy === next.taxPolicy &&
    prev.mobilizationTarget === next.mobilizationTarget &&
    prev.civilianManpowerPotential === next.civilianManpowerPotential &&
    prev.militaryCapacity === next.militaryCapacity &&
    governmentProfileEqual(prev.governmentProfile, next.governmentProfile) &&
    politicalFactionArrayEqual(
      prev.politicalFactions,
      next.politicalFactions,
    ) &&
    nationalInterestsEqual(prev.nationalInterests, next.nationalInterests) &&
    prev.nationalAgenda === next.nationalAgenda &&
    diplomaticRelationArrayEqual(
      prev.diplomaticRelations,
      next.diplomaticRelations,
    ) &&
    diplomaticMemoryArrayEqual(
      prev.diplomaticMemories,
      next.diplomaticMemories,
    ) &&
    tradeContractArrayEqual(prev.tradeContracts, next.tradeContracts) &&
    diplomaticCrisisArrayEqual(prev.diplomaticCrises, next.diplomaticCrises) &&
    diplomaticProposalArrayEqual(
      prev.diplomaticProposals,
      next.diplomaticProposals,
    ) &&
    diplomaticIncidentArrayEqual(
      prev.diplomaticIncidents,
      next.diplomaticIncidents,
    ) &&
    casusBelliArrayEqual(prev.casusBelli, next.casusBelli) &&
    warGoalArrayEqual(prev.warGoals, next.warGoals) &&
    napArrayEqual(prev.nonAggressionPacts, next.nonAggressionPacts) &&
    napArrayEqual(prev.tradeAgreements, next.tradeAgreements) &&
    napArrayEqual(prev.truces, next.truces) &&
    stringArrayEqual(prev.guarantees, next.guarantees) &&
    prev.lastDeleteUnitTick === next.lastDeleteUnitTick &&
    prev.isLobbyCreator === next.isLobbyCreator &&
    numberArrayEqual(prev.allies, next.allies) &&
    numberArrayEqual(prev.targets, next.targets) &&
    stringArrayEqual(
      prev.outgoingAllianceRequests,
      next.outgoingAllianceRequests,
    ) &&
    stringSetEqual(prev.embargoes, next.embargoes) &&
    emojiArrayEqual(prev.outgoingEmojis, next.outgoingEmojis) &&
    attackArrayMembershipEqual(prev.outgoingAttacks, next.outgoingAttacks) &&
    attackArrayMembershipEqual(prev.incomingAttacks, next.incomingAttacks) &&
    allianceArrayEqual(prev.alliances, next.alliances)
  ) {
    return null;
  }

  const diff: PlayerUpdate = { type: GameUpdateType.Player, id: next.id };
  let changed = false;

  const setIfDifferent = <K extends keyof PlayerUpdate>(
    key: K,
    equal: boolean,
  ) => {
    if (!equal) {
      (diff[key] as PlayerUpdate[K]) = next[key] as PlayerUpdate[K];
      changed = true;
    }
  };

  setIfDifferent("clientID", prev.clientID === next.clientID);
  setIfDifferent("name", prev.name === next.name);
  setIfDifferent("displayName", prev.displayName === next.displayName);
  setIfDifferent("clanTag", prev.clanTag === next.clanTag);
  setIfDifferent("nationFlag", prev.nationFlag === next.nationFlag);
  setIfDifferent("team", prev.team === next.team);
  setIfDifferent("smallID", prev.smallID === next.smallID);
  setIfDifferent("playerType", prev.playerType === next.playerType);
  setIfDifferent("isAlive", prev.isAlive === next.isAlive);
  setIfDifferent("isDisconnected", prev.isDisconnected === next.isDisconnected);
  setIfDifferent("killedBy", prev.killedBy === next.killedBy);
  setIfDifferent("deathPosition", prev.deathPosition === next.deathPosition);
  setIfDifferent("tradeGold", prev.tradeGold === next.tradeGold);
  setIfDifferent("trainGold", prev.trainGold === next.trainGold);
  setIfDifferent("piracyGold", prev.piracyGold === next.piracyGold);
  setIfDifferent("food", prev.food === next.food);
  setIfDifferent("materials", prev.materials === next.materials);
  setIfDifferent("fuel", prev.fuel === next.fuel);
  setIfDifferent("foodProduction", prev.foodProduction === next.foodProduction);
  setIfDifferent(
    "materialsProduction",
    prev.materialsProduction === next.materialsProduction,
  );
  setIfDifferent("fuelProduction", prev.fuelProduction === next.fuelProduction);
  setIfDifferent(
    "foodConsumption",
    prev.foodConsumption === next.foodConsumption,
  );
  setIfDifferent(
    "materialsConsumption",
    prev.materialsConsumption === next.materialsConsumption,
  );
  setIfDifferent(
    "fuelConsumption",
    prev.fuelConsumption === next.fuelConsumption,
  );
  setIfDifferent(
    "resourceShortages",
    shortageEqual(prev.resourceShortages, next.resourceShortages),
  );
  // tilesOwned / gold / troops / goldEarned intentionally absent — see
  // EXCEPTION above (goldEarned churns every tick via worker income).
  setIfDifferent("isTraitor", prev.isTraitor === next.isTraitor);
  setIfDifferent(
    "traitorRemainingTicks",
    prev.traitorRemainingTicks === next.traitorRemainingTicks,
  );
  setIfDifferent(
    "inDoomsdayClock",
    prev.inDoomsdayClock === next.inDoomsdayClock,
  );
  setIfDifferent(
    "markedDoomsdayClockTick",
    prev.markedDoomsdayClockTick === next.markedDoomsdayClockTick,
  );
  setIfDifferent("isDecaying", prev.isDecaying === next.isDecaying);
  setIfDifferent("hasSpawned", prev.hasSpawned === next.hasSpawned);
  setIfDifferent("spawnTile", prev.spawnTile === next.spawnTile);
  setIfDifferent("betrayals", prev.betrayals === next.betrayals);
  setIfDifferent("threat", prev.threat === next.threat);
  setIfDifferent("reputation", prev.reputation === next.reputation);
  setIfDifferent("stability", prev.stability === next.stability);
  setIfDifferent(
    "publicSatisfaction",
    prev.publicSatisfaction === next.publicSatisfaction,
  );
  setIfDifferent("taxPolicy", prev.taxPolicy === next.taxPolicy);
  setIfDifferent(
    "mobilizationTarget",
    prev.mobilizationTarget === next.mobilizationTarget,
  );
  setIfDifferent(
    "civilianManpowerPotential",
    prev.civilianManpowerPotential === next.civilianManpowerPotential,
  );
  setIfDifferent(
    "militaryCapacity",
    prev.militaryCapacity === next.militaryCapacity,
  );
  setIfDifferent(
    "governmentProfile",
    governmentProfileEqual(prev.governmentProfile, next.governmentProfile),
  );
  setIfDifferent(
    "politicalFactions",
    politicalFactionArrayEqual(
      prev.politicalFactions,
      next.politicalFactions,
    ),
  );
  setIfDifferent(
    "nationalInterests",
    nationalInterestsEqual(prev.nationalInterests, next.nationalInterests),
  );
  setIfDifferent("nationalAgenda", prev.nationalAgenda === next.nationalAgenda);
  setIfDifferent(
    "diplomaticRelations",
    diplomaticRelationArrayEqual(
      prev.diplomaticRelations,
      next.diplomaticRelations,
    ),
  );
  setIfDifferent(
    "diplomaticMemories",
    diplomaticMemoryArrayEqual(
      prev.diplomaticMemories,
      next.diplomaticMemories,
    ),
  );
  setIfDifferent(
    "tradeContracts",
    tradeContractArrayEqual(prev.tradeContracts, next.tradeContracts),
  );
  setIfDifferent(
    "diplomaticCrises",
    diplomaticCrisisArrayEqual(prev.diplomaticCrises, next.diplomaticCrises),
  );
  setIfDifferent(
    "diplomaticProposals",
    diplomaticProposalArrayEqual(
      prev.diplomaticProposals,
      next.diplomaticProposals,
    ),
  );
  setIfDifferent(
    "diplomaticIncidents",
    diplomaticIncidentArrayEqual(
      prev.diplomaticIncidents,
      next.diplomaticIncidents,
    ),
  );
  setIfDifferent(
    "casusBelli",
    casusBelliArrayEqual(prev.casusBelli, next.casusBelli),
  );
  setIfDifferent("warGoals", warGoalArrayEqual(prev.warGoals, next.warGoals));
  setIfDifferent(
    "nonAggressionPacts",
    napArrayEqual(prev.nonAggressionPacts, next.nonAggressionPacts),
  );
  setIfDifferent(
    "tradeAgreements",
    napArrayEqual(prev.tradeAgreements, next.tradeAgreements),
  );
  setIfDifferent("truces", napArrayEqual(prev.truces, next.truces));
  setIfDifferent(
    "guarantees",
    stringArrayEqual(prev.guarantees, next.guarantees),
  );
  setIfDifferent(
    "lastDeleteUnitTick",
    prev.lastDeleteUnitTick === next.lastDeleteUnitTick,
  );
  setIfDifferent("isLobbyCreator", prev.isLobbyCreator === next.isLobbyCreator);
  setIfDifferent("allies", numberArrayEqual(prev.allies, next.allies));
  setIfDifferent("targets", numberArrayEqual(prev.targets, next.targets));
  setIfDifferent(
    "outgoingAllianceRequests",
    stringArrayEqual(
      prev.outgoingAllianceRequests,
      next.outgoingAllianceRequests,
    ),
  );
  setIfDifferent("embargoes", stringSetEqual(prev.embargoes, next.embargoes));
  setIfDifferent(
    "outgoingEmojis",
    emojiArrayEqual(prev.outgoingEmojis, next.outgoingEmojis),
  );
  // Attack arrays are compared WITHOUT troop counts: troops change every
  // tick for every active attack and travel via packedAttackUpdates (see
  // packAttackTroopDeltas below). The arrays are only resent when
  // membership/order/retreating changes.
  setIfDifferent(
    "outgoingAttacks",
    attackArrayMembershipEqual(prev.outgoingAttacks, next.outgoingAttacks),
  );
  setIfDifferent(
    "incomingAttacks",
    attackArrayMembershipEqual(prev.incomingAttacks, next.incomingAttacks),
  );
  setIfDifferent(
    "alliances",
    allianceArrayEqual(prev.alliances, next.alliances),
  );

  return changed ? diff : null;
}

/**
 * Merge a partial PlayerUpdate into a long-lived PlayerState in place.
 *
 * Only fields present on `pu` are applied; `undefined` means "no change since
 * last emission". The first emission per player carries every field, so the
 * target state is fully populated after one merge of the initial update.
 */
export function applyStateUpdate(target: PlayerState, pu: PlayerUpdate): void {
  // smallID is identity — never changes for a given player.
  if (pu.isAlive !== undefined) target.isAlive = pu.isAlive;
  if (pu.isDisconnected !== undefined)
    target.isDisconnected = pu.isDisconnected;
  if (pu.killedBy !== undefined) target.killedBy = pu.killedBy;
  if (pu.deathPosition !== undefined) target.deathPosition = pu.deathPosition;
  if (pu.tilesOwned !== undefined) target.tilesOwned = pu.tilesOwned;
  if (pu.gold !== undefined) target.gold = Number(pu.gold);
  if (pu.tradeGold !== undefined) target.tradeGold = Number(pu.tradeGold);
  if (pu.trainGold !== undefined) target.trainGold = Number(pu.trainGold);
  if (pu.piracyGold !== undefined) target.piracyGold = Number(pu.piracyGold);
  if (pu.goldEarned !== undefined) target.goldEarned = Number(pu.goldEarned);
  if (pu.troops !== undefined) target.troops = pu.troops;
  if (pu.food !== undefined) target.food = pu.food;
  if (pu.materials !== undefined) target.materials = pu.materials;
  if (pu.fuel !== undefined) target.fuel = pu.fuel;
  if (pu.foodProduction !== undefined)
    target.foodProduction = pu.foodProduction;
  if (pu.materialsProduction !== undefined)
    target.materialsProduction = pu.materialsProduction;
  if (pu.fuelProduction !== undefined)
    target.fuelProduction = pu.fuelProduction;
  if (pu.foodConsumption !== undefined)
    target.foodConsumption = pu.foodConsumption;
  if (pu.materialsConsumption !== undefined)
    target.materialsConsumption = pu.materialsConsumption;
  if (pu.fuelConsumption !== undefined)
    target.fuelConsumption = pu.fuelConsumption;
  if (pu.resourceShortages !== undefined)
    target.resourceShortages = { ...pu.resourceShortages };
  if (pu.isTraitor !== undefined) target.isTraitor = pu.isTraitor;
  if (pu.traitorRemainingTicks !== undefined) {
    target.traitorRemainingTicks = Math.max(0, pu.traitorRemainingTicks);
  }
  if (pu.inDoomsdayClock !== undefined)
    target.inDoomsdayClock = pu.inDoomsdayClock;
  if (pu.markedDoomsdayClockTick !== undefined) {
    target.markedDoomsdayClockTick = pu.markedDoomsdayClockTick;
  }
  if (pu.isDecaying !== undefined) target.isDecaying = pu.isDecaying;
  if (pu.betrayals !== undefined) target.betrayals = pu.betrayals;
  if (pu.threat !== undefined) target.threat = pu.threat;
  if (pu.reputation !== undefined) target.reputation = pu.reputation;
  if (pu.stability !== undefined) target.stability = pu.stability;
  if (pu.publicSatisfaction !== undefined)
    target.publicSatisfaction = pu.publicSatisfaction;
  if (pu.taxPolicy !== undefined) target.taxPolicy = pu.taxPolicy;
  if (pu.mobilizationTarget !== undefined)
    target.mobilizationTarget = pu.mobilizationTarget;
  if (pu.civilianManpowerPotential !== undefined)
    target.civilianManpowerPotential = pu.civilianManpowerPotential;
  if (pu.militaryCapacity !== undefined)
    target.militaryCapacity = pu.militaryCapacity;
  if (pu.governmentProfile !== undefined)
    target.governmentProfile = { ...pu.governmentProfile };
  if (pu.politicalFactions !== undefined)
    target.politicalFactions = pu.politicalFactions.map((faction) => ({
      ...faction,
    }));
  if (pu.nationalInterests !== undefined)
    target.nationalInterests = {
      ...pu.nationalInterests,
      preferredPartners: pu.nationalInterests.preferredPartners.slice(),
    };
  if (pu.nationalAgenda !== undefined)
    target.nationalAgenda = {
      ...pu.nationalAgenda,
      goals: pu.nationalAgenda.goals.map((goal) => ({ ...goal })),
      concerns: pu.nationalAgenda.concerns.map((item) => ({ ...item })),
      strategicRegions: pu.nationalAgenda.strategicRegions.map((item) => ({
        ...item,
      })),
      rivals: pu.nationalAgenda.rivals.slice(),
      preferredPartners: pu.nationalAgenda.preferredPartners.slice(),
    };
  if (pu.diplomaticRelations !== undefined) {
    target.diplomaticRelations = pu.diplomaticRelations.slice();
  }
  if (pu.diplomaticMemories !== undefined) {
    target.diplomaticMemories = pu.diplomaticMemories.slice();
  }
  if (pu.tradeContracts !== undefined) {
    target.tradeContracts = pu.tradeContracts.slice();
  }
  if (pu.diplomaticCrises !== undefined) {
    target.diplomaticCrises = pu.diplomaticCrises.slice();
  }
  if (pu.diplomaticProposals !== undefined) {
    target.diplomaticProposals = pu.diplomaticProposals.map((proposal) => ({
      ...proposal,
      terms: proposal.terms.map((term) => ({ ...term })),
      reasons: proposal.reasons.map((reason) => ({ ...reason })),
    }));
  }
  if (pu.diplomaticIncidents !== undefined) {
    target.diplomaticIncidents = pu.diplomaticIncidents.map((incident) => ({
      ...incident,
    }));
  }
  if (pu.casusBelli !== undefined) target.casusBelli = pu.casusBelli.slice();
  if (pu.warGoals !== undefined) target.warGoals = pu.warGoals.slice();
  if (pu.nonAggressionPacts !== undefined)
    target.nonAggressionPacts = pu.nonAggressionPacts.slice();
  if (pu.tradeAgreements !== undefined)
    target.tradeAgreements = pu.tradeAgreements.slice();
  if (pu.truces !== undefined) target.truces = pu.truces.slice();
  if (pu.guarantees !== undefined) target.guarantees = pu.guarantees.slice();
  if (pu.hasSpawned !== undefined) target.hasSpawned = pu.hasSpawned;
  if (pu.spawnTile !== undefined) target.spawnTile = pu.spawnTile;
  if (pu.lastDeleteUnitTick !== undefined) {
    target.lastDeleteUnitTick = pu.lastDeleteUnitTick;
  }
  // Slice() to detach from the wire object — accumulated state mustn't share
  // mutable arrays with per-tick update payloads.
  if (pu.allies !== undefined) target.allies = pu.allies.slice();
  if (pu.targets !== undefined) target.targets = pu.targets.slice();
  if (pu.outgoingAllianceRequests !== undefined) {
    target.outgoingAllianceRequests = pu.outgoingAllianceRequests.slice();
  }
  if (pu.outgoingAttacks !== undefined) {
    target.outgoingAttacks = pu.outgoingAttacks;
  }
  if (pu.incomingAttacks !== undefined) {
    target.incomingAttacks = pu.incomingAttacks;
  }
  if (pu.alliances !== undefined) target.alliances = pu.alliances;
  if (pu.outgoingEmojis !== undefined)
    target.outgoingEmojis = pu.outgoingEmojis;
}

function casusBelliArrayEqual(
  a?: {
    type: string;
    targetID: string;
    createdAt: number;
    expiresAt: number;
  }[],
  b?: {
    type: string;
    targetID: string;
    createdAt: number;
    expiresAt: number;
  }[],
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].type !== b[i].type ||
      a[i].targetID !== b[i].targetID ||
      a[i].createdAt !== b[i].createdAt ||
      a[i].expiresAt !== b[i].expiresAt
    )
      return false;
  }
  return true;
}

function napArrayEqual(
  a?: { otherID: string; expiresAt: number }[],
  b?: { otherID: string; expiresAt: number }[],
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++)
    if (a[i].otherID !== b[i].otherID || a[i].expiresAt !== b[i].expiresAt)
      return false;
  return true;
}

function shortageEqual(
  a?: { food: boolean; materials: boolean; fuel: boolean },
  b?: { food: boolean; materials: boolean; fuel: boolean },
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.food === b.food &&
      a.materials === b.materials &&
      a.fuel === b.fuel)
  );
}

function governmentProfileEqual(
  a?: NonNullable<PlayerUpdate["governmentProfile"]>,
  b?: NonNullable<PlayerUpdate["governmentProfile"]>,
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.leaderName === b.leaderName &&
      a.style === b.style &&
      a.generation === b.generation &&
      a.termEndsAt === b.termEndsAt &&
      a.tradeBias === b.tradeBias &&
      a.riskTolerance === b.riskTolerance)
  );
}

function politicalFactionArrayEqual(
  a?: NonNullable<PlayerUpdate["politicalFactions"]>,
  b?: NonNullable<PlayerUpdate["politicalFactions"]>,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].type !== b[i].type ||
      a[i].influence !== b[i].influence ||
      a[i].trend !== b[i].trend ||
      a[i].reason !== b[i].reason
    ) {
      return false;
    }
  }
  return true;
}

function nationalInterestsEqual(
  a?: NonNullable<PlayerUpdate["nationalInterests"]>,
  b?: NonNullable<PlayerUpdate["nationalInterests"]>,
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.security === b.security &&
      a.expansion === b.expansion &&
      a.resourceAccess === b.resourceAccess &&
      stringArrayEqual(a.preferredPartners, b.preferredPartners))
  );
}

function diplomaticRelationArrayEqual(
  a?: {
    otherID: string;
    opinion: number;
    trust: number;
    perceivedThreat: number;
  }[],
  b?: {
    otherID: string;
    opinion: number;
    trust: number;
    perceivedThreat: number;
  }[],
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].otherID !== b[i].otherID ||
      a[i].opinion !== b[i].opinion ||
      a[i].trust !== b[i].trust ||
      a[i].perceivedThreat !== b[i].perceivedThreat
    ) {
      return false;
    }
  }
  return true;
}

function diplomaticMemoryArrayEqual(
  a?: NonNullable<PlayerUpdate["diplomaticMemories"]>,
  b?: NonNullable<PlayerUpdate["diplomaticMemories"]>,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].otherID !== b[i].otherID ||
      a[i].type !== b[i].type ||
      a[i].createdAt !== b[i].createdAt ||
      a[i].opinionImpact !== b[i].opinionImpact ||
      a[i].trustImpact !== b[i].trustImpact ||
      a[i].expiresAt !== b[i].expiresAt ||
      a[i].severity !== b[i].severity ||
      a[i].occurrences !== b[i].occurrences ||
      a[i].regionID !== b[i].regionID
    ) {
      return false;
    }
  }
  return true;
}

function tradeContractArrayEqual(
  a?: NonNullable<PlayerUpdate["tradeContracts"]>,
  b?: NonNullable<PlayerUpdate["tradeContracts"]>,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.sellerID !== y.sellerID ||
      x.buyerID !== y.buyerID ||
      x.resource !== y.resource ||
      x.amountPerDelivery !== y.amountPerDelivery ||
      x.pricePerDelivery !== y.pricePerDelivery ||
      x.intervalTicks !== y.intervalTicks ||
      x.nextDeliveryAt !== y.nextDeliveryAt ||
      x.deliveriesRemaining !== y.deliveriesRemaining ||
      x.deliveredCount !== y.deliveredCount ||
      x.status !== y.status ||
      x.createdAt !== y.createdAt ||
      x.lastFailure !== y.lastFailure
    ) {
      return false;
    }
  }
  return true;
}

function diplomaticCrisisArrayEqual(
  a?: NonNullable<PlayerUpdate["diplomaticCrises"]>,
  b?: NonNullable<PlayerUpdate["diplomaticCrises"]>,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.issuerID !== y.issuerID ||
      x.targetID !== y.targetID ||
      x.demand !== y.demand ||
      x.incidentID !== y.incidentID ||
      x.createdAt !== y.createdAt ||
      x.responseAt !== y.responseAt ||
      x.deadlineAt !== y.deadlineAt ||
      x.status !== y.status
    ) {
      return false;
    }
  }
  return true;
}

function diplomaticProposalArrayEqual(
  a?: NonNullable<PlayerUpdate["diplomaticProposals"]>,
  b?: NonNullable<PlayerUpdate["diplomaticProposals"]>,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.rootProposalID !== y.rootProposalID ||
      x.parentProposalID !== y.parentProposalID ||
      x.revision !== y.revision ||
      x.proposerID !== y.proposerID ||
      x.recipientID !== y.recipientID ||
      x.createdAt !== y.createdAt ||
      x.responseAfter !== y.responseAfter ||
      x.expiresAt !== y.expiresAt ||
      x.status !== y.status ||
      x.settledAt !== y.settledAt ||
      x.terms.length !== y.terms.length ||
      x.reasons.length !== y.reasons.length
    ) {
      return false;
    }
    for (let j = 0; j < x.terms.length; j++) {
      if (JSON.stringify(x.terms[j]) !== JSON.stringify(y.terms[j]))
        return false;
    }
    for (let j = 0; j < x.reasons.length; j++) {
      const xr = x.reasons[j];
      const yr = y.reasons[j];
      if (
        xr.code !== yr.code ||
        xr.impact !== yr.impact ||
        xr.detail !== yr.detail
      ) {
        return false;
      }
    }
  }
  return true;
}

function diplomaticIncidentArrayEqual(
  a?: NonNullable<PlayerUpdate["diplomaticIncidents"]>,
  b?: NonNullable<PlayerUpdate["diplomaticIncidents"]>,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.type !== y.type ||
      x.offenderID !== y.offenderID ||
      x.victimID !== y.victimID ||
      x.createdAt !== y.createdAt ||
      x.severity !== y.severity ||
      x.damages !== y.damages ||
      x.evidence !== y.evidence ||
      x.status !== y.status ||
      x.demandedReparations !== y.demandedReparations ||
      x.settlementAmount !== y.settlementAmount ||
      x.sourceUnitID !== y.sourceUnitID ||
      x.restitutionAvailable !== y.restitutionAvailable
    ) {
      return false;
    }
  }
  return true;
}

function warGoalArrayEqual(
  a?: {
    targetID: string;
    type: string;
    regionID?: number;
    initialTargetTiles?: number;
    remainingTargetTiles?: number;
    warScore?: number;
  }[],
  b?: {
    targetID: string;
    type: string;
    regionID?: number;
    initialTargetTiles?: number;
    remainingTargetTiles?: number;
    warScore?: number;
  }[],
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].targetID !== b[i].targetID ||
      a[i].type !== b[i].type ||
      a[i].regionID !== b[i].regionID ||
      a[i].initialTargetTiles !== b[i].initialTargetTiles ||
      a[i].remainingTargetTiles !== b[i].remainingTargetTiles ||
      a[i].warScore !== b[i].warScore
    )
      return false;
  }
  return true;
}

function numberArrayEqual(a?: number[], b?: number[]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function stringArrayEqual(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function stringSetEqual(a?: Set<string>, b?: Set<string>): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Attack-array equality ignoring troop counts: same attacks, same order,
 * same retreating flags. When this holds, only troop counts can differ, and
 * those travel as packed quads (packAttackTroopDeltas) addressed by index —
 * which stays valid precisely because any membership/order change makes
 * this false and resends the whole array.
 */
function attackArrayMembershipEqual(
  a?: AttackUpdate[],
  b?: AttackUpdate[],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.attackerID !== y.attackerID ||
      x.targetID !== y.targetID ||
      x.id !== y.id ||
      x.retreating !== y.retreating
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Direction lane of a `packedAttackUpdates` quad: which of the owner's attack
 * arrays the index addresses. Encoder (PlayerImpl.toUpdate →
 * packAttackTroopDeltas) and decoder (client GameView.update) must both use
 * these.
 */
export const ATTACK_DELTA_OUTGOING = 0;
export const ATTACK_DELTA_INCOMING = 1;

/**
 * Push a `[ownerSmallID, direction, index, troops]` quad onto `out` for each
 * attack whose troop count changed between `prev` and `next`. No-op when the
 * arrays are not membership-equal — diffPlayerUpdate resends the whole array
 * that tick (carrying fresh troop counts), so patches would be redundant and
 * their indexes unreliable.
 */
export function packAttackTroopDeltas(
  prev: AttackUpdate[] | undefined,
  next: AttackUpdate[] | undefined,
  ownerSmallID: number,
  direction: typeof ATTACK_DELTA_OUTGOING | typeof ATTACK_DELTA_INCOMING,
  out: number[],
): void {
  if (prev === next || !prev || !next) return;
  if (!attackArrayMembershipEqual(prev, next)) return;
  for (let i = 0; i < next.length; i++) {
    if (prev[i].troops !== next[i].troops) {
      out.push(ownerSmallID, direction, i, next[i].troops);
    }
  }
}

function allianceArrayEqual(a?: AllianceView[], b?: AllianceView[]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.other !== y.other ||
      x.createdAt !== y.createdAt ||
      x.expiresAt !== y.expiresAt ||
      x.hasExtensionRequest !== y.hasExtensionRequest
    ) {
      return false;
    }
  }
  return true;
}

function emojiArrayEqual(a?: EmojiMessage[], b?: EmojiMessage[]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.message !== y.message ||
      x.senderID !== y.senderID ||
      x.recipientID !== y.recipientID ||
      x.createdAt !== y.createdAt
    ) {
      return false;
    }
  }
  return true;
}
