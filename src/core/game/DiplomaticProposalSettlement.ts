import { validateDiplomaticProposalForSettlement } from "./DiplomaticProposalValidation";
import { DiplomaticProposal, DiplomaticReason, Game, UnitType } from "./Game";

const TRANSFERABLE_REGIONAL_STRUCTURES = new Set<UnitType>([
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
]);

export interface DiplomaticSettlementResult {
  settled: boolean;
  reasons: DiplomaticReason[];
}

export function settleDiplomaticProposal(
  game: Game,
  proposal: DiplomaticProposal,
): DiplomaticSettlementResult {
  const validation = validateDiplomaticProposalForSettlement(game, proposal);
  if (!validation.valid) return { settled: false, reasons: validation.reasons };

  const proposer = game.player(proposal.proposerID);
  const recipient = game.player(proposal.recipientID);

  // Every precondition is checked above. From here the settlement performs a
  // single deterministic mutation batch without yielding to another tick.
  for (const term of proposal.terms) {
    if (term.kind === "gold_reparations") {
      const payer = game.player(term.payerID);
      const receiver = game.player(term.recipientID);
      payer.removeGold(BigInt(term.amount));
      receiver.addGold(BigInt(term.amount));
      payer.rememberDiplomaticEvent(receiver, "reparations_paid", -4, -2);
      receiver.rememberDiplomaticEvent(payer, "reparations_paid", 8, 6);
      if (term.incidentID !== undefined) {
        game.settleDiplomaticIncident(term.incidentID, term.amount);
      }
    } else if (term.kind === "return_trade_ship") {
      const incident = game.diplomaticIncident(term.incidentID)!;
      const ship = game.unit(incident.sourceUnitID!)!;
      game.player(incident.victimID).captureUnit(ship);
      game.settleDiplomaticIncident(term.incidentID, 0);
    } else if (term.kind === "lift_embargo") {
      game.player(term.embargoerID).stopEmbargo(game.player(term.targetID));
    } else if (term.kind === "cede_region") {
      const cedent = game.player(term.cedentID);
      const receiver = game.player(term.recipientID);
      const structures = cedent
        .units()
        .filter(
          (unit) =>
            unit.isActive() &&
            TRANSFERABLE_REGIONAL_STRUCTURES.has(unit.type()) &&
            game.historicalRegionAt(unit.tile())?.id === term.regionID,
        );
      const tiles = [...cedent.tiles()].filter(
        (tile) => game.historicalRegionAt(tile)?.id === term.regionID,
      );
      // A treaty changes sovereignty without crediting a combat capture.
      for (const structure of structures) structure.setOwner(receiver, false);
      for (const tile of tiles) receiver.conquer(tile);
      cedent.clearWarGoalRegionAgainst(receiver);
      receiver.clearWarGoalRegionAgainst(cedent);
      cedent.rememberDiplomaticEvent(receiver, "territory_lost", -10, -4, {
        severity: 60,
        regionID: term.regionID,
      });
      receiver.rememberDiplomaticEvent(cedent, "territory_returned", 12, 10, {
        severity: 55,
        regionID: term.regionID,
      });
    }
  }
  for (const term of proposal.terms) {
    if (term.kind === "non_aggression_pact") {
      proposer.setNonAggressionPact(recipient, term.durationTicks);
      proposer.updateRelation(recipient, 10);
      recipient.updateRelation(proposer, 10);
      proposer.changeTrust(recipient, 10);
      recipient.changeTrust(proposer, 10);
      proposer.rememberDiplomaticEvent(recipient, "nap_signed", 10, 10);
      recipient.rememberDiplomaticEvent(proposer, "nap_signed", 10, 10);
    } else if (term.kind === "trade_agreement") {
      proposer.setTradeAgreement(recipient, term.durationTicks);
    } else if (term.kind === "end_war") {
      proposer.concludePeaceWith(recipient, term.truceTicks);
    } else if (term.kind === "formal_apology") {
      const offender = game.player(term.offenderID);
      const victim = game.player(term.victimID);
      offender.changeReputation(4);
      victim.updateRelation(offender, 8);
      victim.changeTrust(offender, 6);
      offender.rememberDiplomaticEvent(victim, "apology_offered", 3, 2);
      victim.rememberDiplomaticEvent(offender, "apology_accepted", 8, 6);
      game.settleDiplomaticIncident(term.incidentID, 0);
    }
  }
  return { settled: true, reasons: [{ code: "valid", impact: 0 }] };
}
