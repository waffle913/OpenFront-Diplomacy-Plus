import { validateDiplomaticProposalForSettlement } from "./DiplomaticProposalValidation";
import { DiplomaticProposal, DiplomaticReason, Game } from "./Game";

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
    }
  }
  return { settled: true, reasons: [{ code: "valid", impact: 0 }] };
}
