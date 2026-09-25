import { countriesAreAtWar } from "./DiplomaticProposalValidation";
import {
  DiplomaticReason,
  DiplomaticTerm,
  Game,
  isDiplomacyPlusParticipant,
  Player,
  PlayerID,
  Relation,
} from "./Game";

export interface DiplomaticInitiative {
  targetID: PlayerID;
  terms: DiplomaticTerm[];
  reasons: DiplomaticReason[];
}

const INITIATIVE_COOLDOWN_TICKS = 1800;

function hasRecentProposalBetween(
  game: Game,
  actor: Player,
  targetID: PlayerID,
): boolean {
  return game
    .diplomaticProposalsFor(actor.id())
    .some(
      (proposal) =>
        (proposal.status === "pending" ||
          game.ticks() - proposal.createdAt < INITIATIVE_COOLDOWN_TICKS) &&
        ((proposal.proposerID === actor.id() &&
          proposal.recipientID === targetID) ||
          (proposal.proposerID === targetID &&
            proposal.recipientID === actor.id())),
    );
}

/**
 * Chooses at most one deterministic initiative from persistent state. The
 * caller controls cadence so this remains event/interval driven, not a hot
 * per-tick scan.
 */
export function chooseDiplomaticInitiative(
  game: Game,
  actor: Player,
): DiplomaticInitiative | null {
  const incident = game
    .diplomaticIncidentsFor(actor.id())
    .filter(
      (item) =>
        item.victimID === actor.id() &&
        (item.status === "protested" || item.status === "escalated") &&
        item.damages > 0 &&
        game.hasPlayer(item.offenderID) &&
        !hasRecentProposalBetween(game, actor, item.offenderID),
    )
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        b.damages - a.damages ||
        a.id.localeCompare(b.id),
    )[0];
  if (incident !== undefined) {
    const offender = game.player(incident.offenderID);
    const affordable = Math.min(
      incident.damages,
      Number(offender.gold() > 1_000_000n ? 1_000_000n : offender.gold()),
    );
    if (affordable >= 1) {
      return {
        targetID: offender.id(),
        terms: [
          {
            kind: "gold_reparations",
            payerID: offender.id(),
            recipientID: actor.id(),
            amount: Math.max(1, Math.round(affordable)),
            incidentID: incident.id,
          },
        ],
        reasons: [
          {
            code: "unresolved_incident",
            impact: incident.severity,
            detail: `${incident.damages} or de dommages confirmés`,
          },
        ],
      };
    }
  }

  actor.refreshNationalAgenda();
  const agenda = actor.nationalAgenda();
  const warExhaustion = agenda.concerns.find(
    (concern) => concern.type === "high_war_exhaustion",
  );
  if (warExhaustion !== undefined) {
    const enemy = game
      .players()
      .filter(
        (other) =>
          other !== actor &&
          other.isAlive() &&
          isDiplomacyPlusParticipant(other) &&
          countriesAreAtWar(actor, other) &&
          !hasRecentProposalBetween(game, actor, other.id()),
      )
      .sort(
        (a, b) => b.troops() - a.troops() || a.id().localeCompare(b.id()),
      )[0];
    if (enemy !== undefined) {
      return {
        targetID: enemy.id(),
        terms: [{ kind: "end_war", truceTicks: 1800 }],
        reasons: [
          {
            code: "war_exhaustion",
            impact: warExhaustion.severity,
            detail: warExhaustion.reason,
          },
        ],
      };
    }
  }

  const tradeGoal = agenda.goals.find(
    (goal) =>
      goal.type === "find_trade_partner" ||
      goal.type === "reduce_economic_dependence" ||
      goal.type === "strengthen_alliance",
  );
  const tradeTargetID = tradeGoal?.targetID ?? agenda.preferredPartners[0];
  if (tradeGoal !== undefined && tradeTargetID !== undefined) {
    const target = game.hasPlayer(tradeTargetID)
      ? game.player(tradeTargetID)
      : null;
    if (
      target !== null &&
      target.isAlive() &&
      isDiplomacyPlusParticipant(target) &&
      actor.canTrade(target) &&
      actor.tradeAgreementWith(target) === null &&
      !hasRecentProposalBetween(game, actor, target.id())
    ) {
      return {
        targetID: target.id(),
        terms: [{ kind: "trade_agreement", durationTicks: 3600 }],
        reasons: [
          {
            code:
              tradeGoal.type === "strengthen_alliance"
                ? "diplomatic_isolation"
                : "trade_need",
            impact: tradeGoal.priority,
            detail: tradeGoal.reason,
          },
        ],
      };
    }
  }

  const security = agenda.concerns
    .filter(
      (concern) =>
        (concern.type === "powerful_neighbour" ||
          concern.type === "military_vulnerability") &&
        concern.targetID !== undefined,
    )
    .sort((a, b) => b.severity - a.severity)[0];
  if (security?.targetID !== undefined && game.hasPlayer(security.targetID)) {
    const target = game.player(security.targetID);
    if (
      target.isAlive() &&
      isDiplomacyPlusParticipant(target) &&
      actor.relation(target) !== Relation.Hostile &&
      actor.trust(target) >= 35 &&
      !countriesAreAtWar(actor, target) &&
      actor.nonAggressionPactWith(target) === null &&
      !hasRecentProposalBetween(game, actor, target.id())
    ) {
      return {
        targetID: target.id(),
        terms: [{ kind: "non_aggression_pact", durationTicks: 3600 }],
        reasons: [
          {
            code: "security_concern",
            impact: security.severity,
            detail: security.reason,
          },
        ],
      };
    }
  }

  return null;
}
