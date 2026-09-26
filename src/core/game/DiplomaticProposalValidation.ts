import {
  DiplomaticProposal,
  DiplomaticReason,
  DiplomaticTerm,
  DiplomaticValidationResult,
  Game,
  isDiplomacyPlusParticipant,
  Player,
  UnitType,
} from "./Game";

function result(reasons: DiplomaticReason[]): DiplomaticValidationResult {
  return { valid: reasons.length === 0, reasons };
}

export function countriesAreAtWar(a: Player, b: Player): boolean {
  return (
    a.isWarAuthorizedAgainst(b) ||
    b.isWarAuthorizedAgainst(a) ||
    a.outgoingAttacks().some((attack) => attack.target() === b) ||
    b.outgoingAttacks().some((attack) => attack.target() === a)
  );
}

export function validateDiplomaticTerms(
  game: Game,
  proposer: Player,
  recipient: Player,
  terms: readonly DiplomaticTerm[],
): DiplomaticValidationResult {
  const reasons: DiplomaticReason[] = [];
  if (
    !isDiplomacyPlusParticipant(proposer) ||
    !isDiplomacyPlusParticipant(recipient)
  ) {
    reasons.push({ code: "invalid_participant", impact: -100 });
  }
  if (proposer === recipient) {
    reasons.push({ code: "same_country", impact: -100 });
  }
  if (!proposer.isAlive() || !recipient.isAlive()) {
    reasons.push({ code: "country_not_alive", impact: -100 });
  }
  if (terms.length === 0) {
    reasons.push({ code: "empty_terms", impact: -100 });
    return result(reasons);
  }

  const kinds = new Set<string>();
  const atWar = countriesAreAtWar(proposer, recipient);
  for (const term of terms) {
    if (kinds.has(term.kind)) {
      reasons.push({ code: "duplicate_term", impact: -100, detail: term.kind });
      continue;
    }
    kinds.add(term.kind);
    if (term.kind === "non_aggression_pact") {
      if (
        !Number.isSafeInteger(term.durationTicks) ||
        term.durationTicks < 100 ||
        term.durationTicks > 36_000
      ) {
        reasons.push({ code: "invalid_term", impact: -100, detail: term.kind });
      }
      if (atWar) reasons.push({ code: "active_war", impact: -100 });
      if (proposer.nonAggressionPactWith(recipient) !== null) {
        reasons.push({ code: "already_active", impact: -100 });
      }
    } else if (term.kind === "trade_agreement") {
      if (
        !Number.isSafeInteger(term.durationTicks) ||
        term.durationTicks < 100 ||
        term.durationTicks > 36_000
      ) {
        reasons.push({ code: "invalid_term", impact: -100, detail: term.kind });
      }
      if (!proposer.canTrade(recipient)) {
        reasons.push({ code: "trade_blocked", impact: -100 });
      }
      if (proposer.tradeAgreementWith(recipient) !== null) {
        reasons.push({ code: "already_active", impact: -100 });
      }
    } else if (term.kind === "end_war") {
      if (!atWar) reasons.push({ code: "war_required", impact: -100 });
      if (
        !Number.isSafeInteger(term.truceTicks) ||
        term.truceTicks < 100 ||
        term.truceTicks > 36_000
      ) {
        reasons.push({ code: "invalid_term", impact: -100, detail: term.kind });
      }
    } else if (term.kind === "gold_reparations") {
      const parties = new Set([proposer.id(), recipient.id()]);
      if (
        !parties.has(term.payerID) ||
        !parties.has(term.recipientID) ||
        term.payerID === term.recipientID
      ) {
        reasons.push({ code: "invalid_participant", impact: -100 });
      }
      if (
        !Number.isSafeInteger(term.amount) ||
        term.amount < 1 ||
        term.amount > 1_000_000
      ) {
        reasons.push({ code: "invalid_term", impact: -100, detail: term.kind });
      }
      if (term.incidentID !== undefined) {
        const incident = game.diplomaticIncident(term.incidentID);
        if (incident === null) {
          reasons.push({ code: "incident_missing", impact: -100 });
        } else {
          if (
            incident.offenderID !== term.payerID ||
            incident.victimID !== term.recipientID
          ) {
            reasons.push({ code: "invalid_participant", impact: -100 });
          }
          if (
            incident.status === "settled" ||
            incident.status === "dismissed"
          ) {
            reasons.push({ code: "incident_resolved", impact: -100 });
          }
          if (term.amount > Math.max(1, incident.damages * 2)) {
            reasons.push({
              code: "reparations_exceed_damages",
              impact: -100,
              detail: `${incident.damages}`,
            });
          }
        }
      } else if (!atWar) {
        reasons.push({ code: "war_required", impact: -100 });
      }
      if (
        game.hasPlayer(term.payerID) &&
        game.player(term.payerID).gold() < BigInt(Math.max(0, term.amount))
      ) {
        reasons.push({ code: "insufficient_gold", impact: -100 });
      }
    } else if (term.kind === "formal_apology") {
      const incident = game.diplomaticIncident(term.incidentID);
      const parties = new Set([proposer.id(), recipient.id()]);
      if (
        !parties.has(term.offenderID) ||
        !parties.has(term.victimID) ||
        term.offenderID === term.victimID
      ) {
        reasons.push({ code: "invalid_participant", impact: -100 });
      }
      if (incident === null) {
        reasons.push({ code: "incident_missing", impact: -100 });
      } else if (
        incident.offenderID !== term.offenderID ||
        incident.victimID !== term.victimID
      ) {
        reasons.push({ code: "invalid_participant", impact: -100 });
      } else if (
        incident.status === "settled" ||
        incident.status === "dismissed"
      ) {
        reasons.push({ code: "incident_resolved", impact: -100 });
      }
    } else if (term.kind === "return_trade_ship") {
      const incident = game.diplomaticIncident(term.incidentID);
      if (incident === null) {
        reasons.push({ code: "incident_missing", impact: -100 });
      } else if (
        ![proposer.id(), recipient.id()].includes(incident.offenderID) ||
        ![proposer.id(), recipient.id()].includes(incident.victimID)
      ) {
        reasons.push({ code: "invalid_participant", impact: -100 });
      } else if (
        incident.status === "settled" ||
        incident.status === "dismissed"
      ) {
        reasons.push({ code: "incident_resolved", impact: -100 });
      } else {
        const ship =
          incident.sourceUnitID === undefined
            ? undefined
            : game.unit(incident.sourceUnitID);
        if (
          incident.restitutionAvailable !== true ||
          ship === undefined ||
          !ship.isActive() ||
          ship.type() !== UnitType.TradeShip ||
          ship.owner().id() !== incident.offenderID
        ) {
          reasons.push({ code: "restitution_unavailable", impact: -100 });
        }
      }
    } else if (term.kind === "cede_region") {
      const parties = new Set([proposer.id(), recipient.id()]);
      if (
        !parties.has(term.cedentID) ||
        !parties.has(term.recipientID) ||
        term.cedentID === term.recipientID
      ) {
        reasons.push({ code: "invalid_participant", impact: -100 });
        continue;
      }
      if (!Number.isSafeInteger(term.regionID) || term.regionID < 1) {
        reasons.push({ code: "invalid_term", impact: -100, detail: term.kind });
        continue;
      }
      const region = game
        .historicalRegions()
        .find((candidate) => candidate.id === term.regionID);
      if (region === undefined) {
        reasons.push({ code: "region_missing", impact: -100 });
        continue;
      }
      const cedent = game.player(term.cedentID);
      const ownedTiles = game.historicalRegionOwnedTiles(term.regionID, cedent);
      if (ownedTiles <= 0) {
        reasons.push({ code: "region_not_controlled", impact: -100 });
        continue;
      }
      // V1 safety rules. These are deliberately local to CedeRegion so a
      // later peace system can replace them without turning them into global
      // territorial invariants.
      if (region.founderID === cedent.id()) {
        reasons.push({ code: "protected_national_core", impact: -100 });
      }
      const remainingTiles = cedent.numTilesOwned() - ownedTiles;
      if (remainingTiles <= 0) {
        reasons.push({ code: "country_elimination_risk", impact: -100 });
      } else {
        const minimumViableTiles = Math.min(
          10,
          Math.max(1, Math.ceil(cedent.numTilesOwned() * 0.1)),
        );
        if (remainingTiles < minimumViableTiles) {
          reasons.push({ code: "last_viable_territory", impact: -100 });
        }
      }
    }
  }
  return result(reasons);
}

export function validateDiplomaticProposalForSettlement(
  game: Game,
  proposal: DiplomaticProposal,
): DiplomaticValidationResult {
  if (
    !game.hasPlayer(proposal.proposerID) ||
    !game.hasPlayer(proposal.recipientID)
  ) {
    return result([{ code: "country_not_alive", impact: -100 }]);
  }
  return validateDiplomaticTerms(
    game,
    game.player(proposal.proposerID),
    game.player(proposal.recipientID),
    proposal.terms,
  );
}
