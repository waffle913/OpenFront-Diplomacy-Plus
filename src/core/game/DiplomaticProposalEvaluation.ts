import { countriesAreAtWar } from "./DiplomaticProposalValidation";
import {
  DiplomaticProposal,
  DiplomaticProposalEvaluation,
  DiplomaticReason,
  DiplomaticTerm,
  Game,
  Player,
  Relation,
} from "./Game";

export function evaluateDiplomaticProposal(
  game: Game,
  evaluator: Player,
  proposal: DiplomaticProposal,
): DiplomaticProposalEvaluation {
  const proposer = game.player(proposal.proposerID);
  const reasons: DiplomaticReason[] = [];
  let score = 0;
  const add = (reason: DiplomaticReason) => {
    score += reason.impact;
    reasons.push(reason);
  };
  const faction = (type: string) =>
    evaluator.politicalFactions().find((item) => item.type === type)
      ?.influence ?? 20;

  const trust = evaluator.trust(proposer);
  const opinion = evaluator.relationScore(proposer);
  if (trust >= 60)
    add({ code: "high_trust", impact: 18, detail: `${Math.round(trust)}` });
  else if (trust < 35)
    add({ code: "low_trust", impact: -22, detail: `${Math.round(trust)}` });
  if (opinion >= 30 || evaluator.relation(proposer) === Relation.Friendly) {
    add({
      code: "favorable_relations",
      impact: 15,
      detail: `${Math.round(opinion)}`,
    });
  } else if (opinion < -25) {
    add({ code: "low_trust", impact: -15, detail: `${Math.round(opinion)}` });
  }

  const agenda = evaluator.nationalAgenda();
  if (agenda.preferredPartners.includes(proposer.id())) {
    add({ code: "agenda_support", impact: 12 });
  }
  if (agenda.rivals.includes(proposer.id())) {
    add({ code: "agenda_opposition", impact: -18 });
  }

  for (const term of proposal.terms) {
    if (term.kind === "non_aggression_pact") {
      add({ code: "favorable_relations", impact: 12 });
      add({
        code: "faction_influence",
        impact: Math.round(
          (faction("diplomats") + faction("isolationists") - 40) * 0.35,
        ),
        detail: "diplomates et isolationnistes",
      });
    } else if (term.kind === "trade_agreement") {
      add({
        code: "government_preference",
        impact: Math.round(12 + evaluator.governmentProfile().tradeBias * 60),
      });
      add({
        code: "faction_influence",
        impact: Math.round((faction("merchants") - 20) * 0.7),
        detail: "marchands",
      });
    } else if (term.kind === "end_war") {
      const exhausted =
        evaluator.resources().food <=
          evaluator.resourceConsumption().food * 10 ||
        evaluator.resources().fuel <=
          evaluator.resourceConsumption().fuel * 10 ||
        evaluator.publicSatisfaction() < 45;
      if (exhausted) add({ code: "economic_exhaustion", impact: 35 });
      const ratio = proposer.troops() / Math.max(1, evaluator.troops());
      if (ratio >= 1.25) add({ code: "military_disadvantage", impact: 25 });
      else if (ratio < 0.8) add({ code: "military_leverage", impact: -20 });
      if (countriesAreAtWar(evaluator, proposer))
        add({ code: "war_required", impact: 10 });
      add({
        code: "faction_influence",
        impact: Math.round(
          (faction("diplomats") + faction("isolationists") - 40) * 0.55,
        ),
        detail: "diplomates et isolationnistes",
      });
    } else if (term.kind === "gold_reparations") {
      if (term.recipientID === evaluator.id()) {
        add({ code: "reasonable_reparations", impact: 30 });
      } else {
        if (term.incidentID !== undefined) {
          const incident = game.diplomaticIncident(term.incidentID);
          if (incident?.evidence === "confirmed") {
            add({
              code: "confirmed_incident",
              impact: term.amount <= incident.damages ? 25 : 5,
              detail: `${incident.damages}`,
            });
          }
        }
        const share = term.amount / Math.max(1, Number(evaluator.gold()));
        if (share <= 0.2) add({ code: "economic_cost", impact: -12 });
        else
          add({
            code: "excessive_reparations",
            impact: -45,
            detail: `${term.amount}`,
          });
      }
    } else if (term.kind === "formal_apology") {
      const incident = game.diplomaticIncident(term.incidentID);
      if (term.offenderID === evaluator.id()) {
        add({
          code: "accountability",
          impact: incident?.evidence === "confirmed" ? 22 : 8,
          detail: incident?.type,
        });
        if (evaluator.governmentProfile().style === "hawkish") {
          add({ code: "government_preference", impact: -12 });
        }
        add({
          code: "faction_influence",
          impact: Math.round(
            (faction("diplomats") - faction("military")) * 0.35,
          ),
          detail: "diplomates contre militaires",
        });
      } else {
        add({ code: "accountability", impact: 25 });
      }
    } else if (term.kind === "return_trade_ship") {
      const incident = game.diplomaticIncident(term.incidentID);
      add({
        code: "accountability",
        impact: incident?.evidence === "confirmed" ? 30 : 10,
        detail: "restitution du navire",
      });
    } else if (term.kind === "lift_embargo") {
      if (term.targetID === evaluator.id()) {
        add({ code: "trade_need", impact: 28, detail: "levée de l’embargo" });
      } else {
        add({
          code: "economic_cost",
          impact:
            evaluator.relationScore(proposer) >= 0 ||
            evaluator.governmentProfile().style === "cooperative"
              ? -8
              : -22,
          detail: "abandon d’un embargo",
        });
        add({
          code: "faction_influence",
          impact: Math.round((faction("merchants") - 20) * 0.6),
          detail: "marchands",
        });
      }
    } else if (term.kind === "cede_region") {
      const region = game
        .historicalRegions()
        .find((candidate) => candidate.id === term.regionID);
      const strategic = agenda.strategicRegions.find(
        (candidate) => candidate.regionID === term.regionID,
      );
      if (term.recipientID === evaluator.id()) {
        add({
          code: "strategic_region",
          impact: strategic === undefined ? 30 : 30 + strategic.priority / 4,
          detail: region?.name ?? `${term.regionID}`,
        });
      } else {
        add({
          code: "strategic_region",
          impact: strategic === undefined ? -35 : -35 - strategic.priority / 3,
          detail: region?.name ?? `${term.regionID}`,
        });
        if (proposer.warGoalRegionAgainst(evaluator) === term.regionID) {
          add({ code: "military_disadvantage", impact: 18 });
        }
        const ratio = proposer.troops() / Math.max(1, evaluator.troops());
        if (ratio >= 1.25) add({ code: "military_disadvantage", impact: 22 });
        else if (ratio < 0.8) add({ code: "military_leverage", impact: -18 });
        add({
          code: "faction_influence",
          impact: Math.round(
            (faction("diplomats") +
              faction("isolationists") -
              faction("military") -
              faction("expansionists")) *
              0.35,
          ),
          detail: "paix contre intérêts territoriaux",
        });
      }
    }
  }

  const threshold = 0;
  reasons.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  if (score >= threshold) {
    return { decision: "accept", score, threshold, reasons };
  }

  const reparations = proposal.terms.find(
    (term): term is Extract<DiplomaticTerm, { kind: "gold_reparations" }> =>
      term.kind === "gold_reparations" && term.payerID === evaluator.id(),
  );
  if (score >= -35 && reparations !== undefined && reparations.amount > 1) {
    const counterTerms = proposal.terms.map((term) =>
      term === reparations
        ? { ...term, amount: Math.max(1, Math.floor(term.amount / 2)) }
        : { ...term },
    );
    return {
      decision: "counter",
      score,
      threshold,
      reasons,
      counterTerms,
    };
  }
  return { decision: "reject", score, threshold, reasons };
}
