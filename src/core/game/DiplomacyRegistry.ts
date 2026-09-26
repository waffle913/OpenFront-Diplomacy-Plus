import { simpleHash } from "../Util";
import { settleDiplomaticProposal } from "./DiplomaticProposalSettlement";
import { validateDiplomaticTerms } from "./DiplomaticProposalValidation";
import {
  DiplomaticIncident,
  DiplomaticIncidentType,
  DiplomaticProposal,
  DiplomaticProposalResult,
  DiplomaticReason,
  DiplomaticTerm,
  Game,
  isDiplomacyPlusParticipant,
  Player,
  PlayerID,
} from "./Game";

const PROPOSAL_LIFETIME_TICKS = 600;
const RESPONSE_DELAY_TICKS = 10;
const INCIDENT_AGGREGATION_TICKS = 300;
const MAX_INCIDENT_HISTORY = 256;
const MAX_PROPOSAL_HISTORY = 1024;

function cloneTerm(term: DiplomaticTerm): DiplomaticTerm {
  return { ...term };
}

function termIncidentID(term: DiplomaticTerm): string | undefined {
  if (
    term.kind === "gold_reparations" ||
    term.kind === "formal_apology" ||
    term.kind === "return_trade_ship"
  ) {
    return term.incidentID;
  }
  return undefined;
}

function termSignature(terms: readonly DiplomaticTerm[]): string {
  return terms
    .map((term) => {
      if (term.kind === "non_aggression_pact")
        return `nap:${term.durationTicks}`;
      if (term.kind === "trade_agreement") return `trade:${term.durationTicks}`;
      if (term.kind === "end_war") return `peace:${term.truceTicks}`;
      if (term.kind === "gold_reparations")
        return `gold:${term.payerID}:${term.recipientID}:${term.amount}:${term.incidentID ?? ""}`;
      if (term.kind === "formal_apology")
        return `apology:${term.offenderID}:${term.victimID}:${term.incidentID}`;
      if (term.kind === "return_trade_ship")
        return `restitution:${term.incidentID}`;
      return `cede:${term.cedentID}:${term.recipientID}:${term.regionID}`;
    })
    .sort()
    .join("|");
}

export class DiplomacyRegistry {
  private readonly proposals = new Map<string, DiplomaticProposal>();
  private readonly incidents = new Map<string, DiplomaticIncident>();
  private nextProposalID = 1;
  private nextIncidentID = 1;
  private revision = 0;
  private readonly views = new Map<
    PlayerID,
    { revision: number; proposals: readonly DiplomaticProposal[] }
  >();

  constructor(private readonly game: Game) {}

  version(): number {
    return this.revision;
  }

  proposal(id: string): DiplomaticProposal | null {
    return this.proposals.get(id) ?? null;
  }

  incidentsFor(playerID: PlayerID): readonly DiplomaticIncident[] {
    return [...this.incidents.values()]
      .filter(
        (incident) =>
          incident.offenderID === playerID || incident.victimID === playerID,
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  incident(id: string): DiplomaticIncident | null {
    return this.incidents.get(id) ?? null;
  }

  recordIncident(
    type: DiplomaticIncidentType,
    offender: Player,
    victim: Player,
    damages: number,
    sourceUnitID?: number,
  ): DiplomaticIncident | null {
    if (
      offender === victim ||
      !offender.isAlive() ||
      !victim.isAlive() ||
      !isDiplomacyPlusParticipant(offender) ||
      !isDiplomacyPlusParticipant(victim)
    ) {
      return null;
    }
    const now = this.game.ticks();
    const existing = [...this.incidents.values()].find(
      (incident) =>
        incident.type === type &&
        incident.offenderID === offender.id() &&
        incident.victimID === victim.id() &&
        ["unresolved", "protested", "escalated"].includes(incident.status) &&
        now - incident.createdAt <= INCIDENT_AGGREGATION_TICKS,
    );
    if (existing !== undefined) {
      existing.damages += Math.max(0, Math.round(damages));
      existing.severity = Math.min(100, existing.severity + 8);
      existing.sourceUnitID = sourceUnitID;
      existing.restitutionAvailable = sourceUnitID !== undefined;
      victim.rememberDiplomaticEvent(offender, type, -8, -8, {
        severity: existing.severity,
      });
      this.touch();
      return existing;
    }
    const incident: DiplomaticIncident = {
      id: `di:${this.nextIncidentID++}`,
      type,
      offenderID: offender.id(),
      victimID: victim.id(),
      createdAt: now,
      severity: type === "trade_ship_destroyed" ? 65 : 50,
      damages: Math.max(0, Math.round(damages)),
      evidence: "confirmed",
      status: "unresolved",
      sourceUnitID,
      restitutionAvailable: sourceUnitID !== undefined,
    };
    this.incidents.set(incident.id, incident);
    victim.rememberDiplomaticEvent(offender, type, -12, -15, {
      severity: incident.severity,
    });
    victim.updateRelation(offender, -8);
    victim.changeTrust(offender, -10);
    this.pruneIncidentHistory();
    this.touch();
    return incident;
  }

  updateIncidentDamages(id: string, damages: number): void {
    const incident = this.incidents.get(id);
    if (incident === undefined || incident.status === "settled") return;
    incident.damages += Math.max(0, Math.round(damages));
    incident.restitutionAvailable = false;
    this.touch();
  }

  protestIncident(actor: Player, id: string): boolean {
    const incident = this.incidents.get(id);
    if (
      incident === undefined ||
      incident.victimID !== actor.id() ||
      incident.status !== "unresolved"
    ) {
      return false;
    }
    incident.status = "protested";
    this.touch();
    return true;
  }

  dismissIncident(actor: Player, id: string): boolean {
    const incident = this.incidents.get(id);
    if (
      incident === undefined ||
      incident.victimID !== actor.id() ||
      !["unresolved", "protested", "escalated"].includes(incident.status)
    ) {
      return false;
    }
    incident.status = "dismissed";
    incident.restitutionAvailable = false;
    this.touch();
    return true;
  }

  sanctionIncident(actor: Player, id: string): boolean {
    const incident = this.incidents.get(id);
    if (
      incident === undefined ||
      incident.victimID !== actor.id() ||
      !["protested", "escalated"].includes(incident.status) ||
      !this.game.hasPlayer(incident.offenderID)
    ) {
      return false;
    }
    const offender = this.game.player(incident.offenderID);
    if (!offender.isAlive()) return false;
    actor.addEmbargo(offender, false);
    actor.rememberDiplomaticEvent(offender, "sanctions_imposed", -8, -5, {
      severity: incident.severity,
    });
    offender.rememberDiplomaticEvent(actor, "sanctions_imposed", -12, -10, {
      severity: incident.severity,
    });
    incident.status = "sanctioned";
    incident.severity = Math.min(100, incident.severity + 8);
    this.touch();
    return true;
  }

  issueUltimatum(actor: Player, id: string): boolean {
    const incident = this.incidents.get(id);
    if (
      incident === undefined ||
      incident.victimID !== actor.id() ||
      !["escalated", "sanctioned"].includes(incident.status) ||
      !this.game.hasPlayer(incident.offenderID)
    ) {
      return false;
    }
    const offender = this.game.player(incident.offenderID);
    if (!actor.startDiplomaticCrisis(offender, incident.id)) return false;
    incident.status = "ultimatum";
    incident.severity = Math.min(100, incident.severity + 10);
    this.touch();
    return true;
  }

  settleIncident(id: string, amount: number): void {
    const incident = this.incidents.get(id);
    if (incident === undefined) return;
    incident.status = "settled";
    incident.settlementAmount = Math.max(0, Math.round(amount));
    incident.restitutionAvailable = false;
    this.touch();
  }

  escalateIncident(id: string): void {
    const incident = this.incidents.get(id);
    if (incident === undefined || incident.status === "settled") return;
    incident.status = "escalated";
    incident.severity = Math.min(100, incident.severity + 10);
    this.touch();
  }

  proposalsFor(playerID: PlayerID): readonly DiplomaticProposal[] {
    const cached = this.views.get(playerID);
    if (cached?.revision === this.revision) return cached.proposals;
    const proposals = [...this.proposals.values()]
      .filter(
        (proposal) =>
          proposal.proposerID === playerID || proposal.recipientID === playerID,
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    this.views.set(playerID, { revision: this.revision, proposals });
    return proposals;
  }

  create(
    proposer: Player,
    recipient: Player,
    terms: DiplomaticTerm[],
    parentProposalID?: string,
    reasons: DiplomaticReason[] = [{ code: "valid", impact: 0 }],
  ): DiplomaticProposalResult {
    const validation = validateDiplomaticTerms(
      this.game,
      proposer,
      recipient,
      terms,
    );
    if (!validation.valid)
      return { accepted: false, reasons: validation.reasons };

    const signature = termSignature(terms);
    const duplicate = [...this.proposals.values()].some(
      (proposal) =>
        proposal.id !== parentProposalID &&
        proposal.status === "pending" &&
        proposal.proposerID === proposer.id() &&
        proposal.recipientID === recipient.id() &&
        termSignature(proposal.terms) === signature,
    );
    if (duplicate) {
      return {
        accepted: false,
        reasons: [{ code: "duplicate_pending", impact: -100 }],
      };
    }

    const now = this.game.ticks();
    const id = `dp:${this.nextProposalID++}`;
    const parent = parentProposalID
      ? this.proposals.get(parentProposalID)
      : undefined;
    const proposal: DiplomaticProposal = {
      id,
      rootProposalID: parent?.rootProposalID ?? id,
      parentProposalID,
      revision: parent === undefined ? 0 : parent.revision + 1,
      proposerID: proposer.id(),
      recipientID: recipient.id(),
      createdAt: now,
      responseAfter: now + RESPONSE_DELAY_TICKS,
      expiresAt: now + PROPOSAL_LIFETIME_TICKS,
      status: "pending",
      terms: terms.map(cloneTerm),
      reasons: reasons.map((reason) => ({ ...reason })),
    };
    this.proposals.set(id, proposal);
    for (const term of proposal.terms) {
      const incidentID = termIncidentID(term);
      if (incidentID === undefined) continue;
      const incident = this.incidents.get(incidentID);
      if (incident !== undefined) {
        incident.status = "negotiating";
        if (term.kind === "gold_reparations") {
          incident.demandedReparations = term.amount;
        }
      }
    }
    this.pruneProposalHistory();
    this.touch();
    return { accepted: true, proposal, reasons: proposal.reasons };
  }

  accept(
    actor: Player,
    proposalID: string,
    reasons: DiplomaticReason[] = [{ code: "valid", impact: 0 }],
  ): DiplomaticProposalResult {
    return this.respond(
      actor,
      proposalID,
      "accepted_pending_settlement",
      reasons,
    );
  }

  reject(
    actor: Player,
    proposalID: string,
    reasons: DiplomaticReason[] = [],
  ): DiplomaticProposalResult {
    return this.respond(actor, proposalID, "rejected", reasons);
  }

  withdraw(actor: Player, proposalID: string): DiplomaticProposalResult {
    const proposal = this.proposals.get(proposalID);
    if (!proposal) return this.failure("proposal_missing");
    if (proposal.proposerID !== actor.id()) return this.failure("not_proposer");
    if (proposal.status !== "pending")
      return this.failure("proposal_not_pending");
    proposal.status = "withdrawn";
    proposal.reasons = [];
    this.restoreIncidentAfterClosedProposal(proposal, "protested");
    this.touch();
    return { accepted: true, proposal, reasons: [] };
  }

  counter(
    actor: Player,
    proposalID: string,
    terms: DiplomaticTerm[],
    reasons: DiplomaticReason[] = [],
  ): DiplomaticProposalResult {
    const proposal = this.proposals.get(proposalID);
    if (!proposal) return this.failure("proposal_missing");
    if (proposal.recipientID !== actor.id())
      return this.failure("not_recipient");
    if (proposal.status !== "pending")
      return this.failure("proposal_not_pending");
    if (!this.game.hasPlayer(proposal.proposerID)) {
      return this.failure("country_not_alive");
    }
    const created = this.create(
      actor,
      this.game.player(proposal.proposerID),
      terms,
      proposal.id,
      reasons,
    );
    if (!created.accepted) return created;
    proposal.status = "countered";
    proposal.reasons = reasons.map((reason) => ({ ...reason }));
    this.touch();
    return created;
  }

  tick(): void {
    const now = this.game.ticks();
    const ordered = [...this.proposals.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    for (const proposal of ordered) {
      if (proposal.status === "pending" && proposal.expiresAt <= now) {
        proposal.status = "expired";
        proposal.reasons = [{ code: "proposal_expired", impact: -100 }];
        this.restoreIncidentAfterClosedProposal(proposal, "protested");
        this.touch();
        continue;
      }
      if (
        proposal.status === "pending" &&
        (!this.game.hasPlayer(proposal.proposerID) ||
          !this.game.hasPlayer(proposal.recipientID) ||
          !this.game.player(proposal.proposerID).isAlive() ||
          !this.game.player(proposal.recipientID).isAlive())
      ) {
        proposal.status = "invalidated";
        proposal.reasons = [{ code: "country_not_alive", impact: -100 }];
        this.restoreIncidentAfterClosedProposal(proposal, "escalated");
        this.touch();
        continue;
      }
      if (proposal.status !== "accepted_pending_settlement") continue;
      const settlement = settleDiplomaticProposal(this.game, proposal);
      proposal.status = settlement.settled ? "settled" : "invalidated";
      if (settlement.settled) {
        proposal.settledAt = now;
      } else {
        proposal.reasons = settlement.reasons.map((reason) => ({ ...reason }));
        this.restoreIncidentAfterClosedProposal(proposal, "escalated");
      }
      this.touch();
    }
  }

  hash(): number {
    let hash = 0;
    const ordered = [...this.proposals.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    for (const proposal of ordered) {
      hash += simpleHash(
        `${proposal.id}:${proposal.rootProposalID}:${proposal.parentProposalID ?? ""}:${proposal.revision}:${proposal.proposerID}:${proposal.recipientID}:${proposal.createdAt}:${proposal.expiresAt}:${proposal.status}:${termSignature(proposal.terms)}:${proposal.reasons.map((r) => `${r.code}:${r.impact}:${r.detail ?? ""}`).join(",")}`,
      );
    }
    for (const incident of [...this.incidents.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      hash += simpleHash(
        `${incident.id}:${incident.type}:${incident.offenderID}:${incident.victimID}:${incident.createdAt}:${incident.severity}:${incident.damages}:${incident.evidence}:${incident.status}:${incident.demandedReparations ?? ""}:${incident.settlementAmount ?? ""}:${incident.sourceUnitID ?? ""}:${incident.restitutionAvailable ?? false}`,
      );
    }
    return hash;
  }

  private respond(
    actor: Player,
    proposalID: string,
    status: "accepted_pending_settlement" | "rejected",
    reasons: DiplomaticReason[],
  ): DiplomaticProposalResult {
    const proposal = this.proposals.get(proposalID);
    if (!proposal) return this.failure("proposal_missing");
    if (proposal.recipientID !== actor.id())
      return this.failure("not_recipient");
    if (proposal.status !== "pending")
      return this.failure("proposal_not_pending");
    if (proposal.expiresAt <= this.game.ticks()) {
      proposal.status = "expired";
      proposal.reasons = [{ code: "proposal_expired", impact: -100 }];
      this.restoreIncidentAfterClosedProposal(proposal, "protested");
      this.touch();
      return this.failure("proposal_expired");
    }
    proposal.status = status;
    proposal.reasons = reasons.map((reason) => ({ ...reason }));
    if (status === "rejected") {
      this.restoreIncidentAfterClosedProposal(proposal, "escalated");
      for (const term of proposal.terms) {
        if (term.kind !== "gold_reparations" || term.incidentID === undefined)
          continue;
        if (
          this.game.hasPlayer(term.payerID) &&
          this.game.hasPlayer(term.recipientID)
        ) {
          const payer = this.game.player(term.payerID);
          const recipient = this.game.player(term.recipientID);
          recipient.rememberDiplomaticEvent(
            payer,
            "reparations_refused",
            -10,
            -10,
          );
          const incident = this.incidents.get(term.incidentID);
          if (incident !== undefined) {
            incident.severity = Math.min(100, incident.severity + 15);
          }
        }
      }
    }
    this.touch();
    return { accepted: true, proposal, reasons: proposal.reasons };
  }

  private failure(code: DiplomaticReason["code"]): DiplomaticProposalResult {
    return { accepted: false, reasons: [{ code, impact: -100 }] };
  }

  private touch(): void {
    this.revision++;
    this.views.clear();
  }

  private restoreIncidentAfterClosedProposal(
    proposal: DiplomaticProposal,
    status: "protested" | "escalated",
  ): void {
    for (const term of proposal.terms) {
      const incidentID = termIncidentID(term);
      if (incidentID === undefined) continue;
      const incident = this.incidents.get(incidentID);
      if (incident?.status === "negotiating") incident.status = status;
    }
  }

  private pruneIncidentHistory(): void {
    if (this.incidents.size <= MAX_INCIDENT_HISTORY) return;
    const activeIncidentIDs = new Set<string>();
    for (const proposal of this.proposals.values()) {
      if (
        proposal.status !== "pending" &&
        proposal.status !== "accepted_pending_settlement"
      ) {
        continue;
      }
      for (const term of proposal.terms) {
        const incidentID = termIncidentID(term);
        if (incidentID !== undefined) activeIncidentIDs.add(incidentID);
      }
    }
    const candidates = [...this.incidents.values()]
      .filter((incident) => !activeIncidentIDs.has(incident.id))
      .sort((a, b) => {
        const aTerminal = ["settled", "dismissed"].includes(a.status) ? 0 : 1;
        const bTerminal = ["settled", "dismissed"].includes(b.status) ? 0 : 1;
        return aTerminal - bTerminal || a.createdAt - b.createdAt;
      });
    while (
      this.incidents.size > MAX_INCIDENT_HISTORY &&
      candidates.length > 0
    ) {
      this.incidents.delete(candidates.shift()!.id);
    }
  }

  private pruneProposalHistory(): void {
    if (this.proposals.size <= MAX_PROPOSAL_HISTORY) return;
    const terminal = [...this.proposals.values()]
      .filter(
        (proposal) =>
          proposal.status !== "pending" &&
          proposal.status !== "accepted_pending_settlement",
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    while (this.proposals.size > MAX_PROPOSAL_HISTORY && terminal.length > 0) {
      this.proposals.delete(terminal.shift()!.id);
    }
  }
}
