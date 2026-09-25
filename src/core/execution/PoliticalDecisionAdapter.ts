import {
  Game,
  isDiplomacyPlusParticipant,
  Player,
  PlayerID,
  StrategicResource,
  TaxPolicy,
} from "../game/Game";
import {
  DiplomacyPlusAction,
  DiplomacyPlusExecution,
} from "./DiplomacyPlusExecution";
import { DomesticPolicyExecution } from "./DomesticPolicyExecution";
import { EmbargoExecution } from "./EmbargoExecution";
import { TradeDirection, TradeExecution } from "./TradeExecution";

export type PoliticalDecision =
  | {
      kind: "diplomacy";
      targetID: PlayerID;
      action: DiplomacyPlusAction;
    }
  | {
      kind: "trade";
      targetID: PlayerID;
      direction: TradeDirection;
      resource: StrategicResource;
      amount: number;
      price: number;
      deliveries: number;
    }
  | { kind: "embargo"; targetID: PlayerID; action: "start" | "stop" }
  | { kind: "domestic_policy"; taxPolicy: TaxPolicy };

export interface PoliticalSnapshot {
  tick: number;
  country: {
    id: PlayerID;
    gold: number;
    troops: number;
    resources: ReturnType<Player["resources"]>;
    consumption: ReturnType<Player["resourceConsumption"]>;
    stability: number;
    publicSatisfaction: number;
    taxPolicy: TaxPolicy;
    threat: number;
    reputation: number;
    government: ReturnType<Player["governmentProfile"]>;
    interests: ReturnType<Player["nationalInterests"]>;
  };
  relations: {
    otherID: PlayerID;
    opinion: number;
    trust: number;
    perceivedThreat: number;
    canTrade: boolean;
  }[];
  memories: ReturnType<Player["diplomaticMemories"]>;
  contracts: ReturnType<Player["tradeContracts"]>;
  crises: ReturnType<Player["diplomaticCrises"]>;
  agenda: ReturnType<Player["nationalAgenda"]>;
}

export interface PoliticalDecisionResult {
  accepted: boolean;
  reason: string;
}

export function buildPoliticalSnapshot(
  game: Game,
  player: Player,
): PoliticalSnapshot {
  if (!isDiplomacyPlusParticipant(player)) {
    throw new Error("Diplomacy+ snapshots are unavailable for tribes");
  }
  player.refreshNationalAgenda();
  return {
    tick: game.ticks(),
    country: {
      id: player.id(),
      gold: Number(player.gold()),
      troops: player.troops(),
      resources: player.resources(),
      consumption: player.resourceConsumption(),
      stability: player.stability(),
      publicSatisfaction: player.publicSatisfaction(),
      taxPolicy: player.taxPolicy(),
      threat: player.threat(),
      reputation: player.reputation(),
      government: player.governmentProfile(),
      interests: player.nationalInterests(),
    },
    relations: game
      .players()
      .filter((other) => other !== player && isDiplomacyPlusParticipant(other))
      .map((other) => ({
        otherID: other.id(),
        opinion: player.relationScore(other),
        trust: player.trust(other),
        perceivedThreat: player.perceivedThreat(other),
        canTrade: player.canTrade(other),
      })),
    memories: player.diplomaticMemories().map((memory) => ({ ...memory })),
    contracts: player.tradeContracts().map((contract) => ({ ...contract })),
    crises: player.diplomaticCrises().map((crisis) => ({ ...crisis })),
    agenda: player.nationalAgenda(),
  };
}

export function submitPoliticalDecision(
  game: Game,
  player: Player,
  decision: PoliticalDecision,
): PoliticalDecisionResult {
  if (!isDiplomacyPlusParticipant(player)) {
    return { accepted: false, reason: "unsupported_country_type" };
  }
  if (!player.isAlive())
    return { accepted: false, reason: "country_not_alive" };

  if (decision.kind === "domestic_policy") {
    game.addExecution(new DomesticPolicyExecution(player, decision.taxPolicy));
    return { accepted: true, reason: "queued" };
  }

  if (!game.hasPlayer(decision.targetID)) {
    return { accepted: false, reason: "target_missing" };
  }
  const target = game.player(decision.targetID);
  if (
    target === player ||
    !target.isAlive() ||
    !isDiplomacyPlusParticipant(target)
  ) {
    return { accepted: false, reason: "invalid_target" };
  }

  if (decision.kind === "diplomacy") {
    if (decision.action === "ultimatum" && player.truceWith(target) !== null) {
      return { accepted: false, reason: "active_truce" };
    }
    game.addExecution(
      new DiplomacyPlusExecution(player, target.id(), decision.action),
    );
    return { accepted: true, reason: "queued" };
  }

  if (decision.kind === "embargo") {
    game.addExecution(
      new EmbargoExecution(player, target.id(), decision.action),
    );
    return { accepted: true, reason: "queued" };
  }

  if (
    !Number.isFinite(decision.amount) ||
    decision.amount < 1 ||
    decision.amount > 1000 ||
    !Number.isSafeInteger(decision.price) ||
    decision.price < 1 ||
    decision.price > 1_000_000 ||
    !Number.isSafeInteger(decision.deliveries) ||
    decision.deliveries < 1 ||
    decision.deliveries > 24 ||
    !player.canTrade(target)
  ) {
    return { accepted: false, reason: "invalid_trade" };
  }
  game.addExecution(
    new TradeExecution(
      player,
      target.id(),
      "offer",
      decision.direction,
      decision.resource,
      decision.amount,
      decision.price,
      decision.deliveries,
    ),
  );
  return { accepted: true, reason: "queued" };
}
