import { simpleHash } from "../Util";
import {
  Game,
  InternationalCharterPrinciple,
  InternationalOrganization,
  InternationalResolution,
  InternationalResolutionKind,
  InternationalVoteChoice,
  isDiplomacyPlusParticipant,
  Player,
  PlayerID,
} from "./Game";

const VOTING_DURATION_TICKS = 600;
const MAX_ORGANIZATIONS = 16;
const MAX_RESOLUTIONS = 256;

export class InternationalOrganizationRegistry {
  private readonly organizations = new Map<string, InternationalOrganization>();
  private readonly resolutions = new Map<string, InternationalResolution>();
  private nextOrganizationID = 1;
  private nextResolutionID = 1;
  private revision = 0;

  constructor(private readonly game: Game) {}

  version(): number {
    return this.revision;
  }

  allOrganizations(): readonly InternationalOrganization[] {
    return [...this.organizations.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  resolutionsFor(playerID: PlayerID): readonly InternationalResolution[] {
    const memberships = new Set(
      this.allOrganizations()
        .filter((organization) => organization.memberIDs.includes(playerID))
        .map((organization) => organization.id),
    );
    return [...this.resolutions.values()]
      .filter(
        (resolution) =>
          memberships.has(resolution.organizationID) ||
          resolution.targetID === playerID ||
          resolution.beneficiaryID === playerID,
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  create(
    founder: Player,
    name: string,
    foundingMembers: Player[],
    principles: InternationalCharterPrinciple[],
  ): InternationalOrganization | null {
    const members = [
      ...new Map(
        [founder, ...foundingMembers].map((member) => [member.id(), member]),
      ).values(),
    ];
    const normalizedName = name.trim().slice(0, 64);
    const uniquePrinciples = [...new Set(principles)].sort();
    if (
      normalizedName.length < 3 ||
      this.organizations.size >= MAX_ORGANIZATIONS ||
      this.allOrganizations().some(
        (organization) => organization.name === normalizedName,
      ) ||
      members.length < 3 ||
      uniquePrinciples.length === 0 ||
      members.some(
        (member) => !member.isAlive() || !isDiplomacyPlusParticipant(member),
      )
    ) {
      return null;
    }
    const organization: InternationalOrganization = {
      id: `io:${this.nextOrganizationID++}`,
      name: normalizedName,
      founderID: founder.id(),
      memberIDs: members.map((member) => member.id()).sort(),
      principles: uniquePrinciples,
      createdAt: this.game.ticks(),
    };
    this.organizations.set(organization.id, organization);
    this.revision++;
    return organization;
  }

  join(actor: Player, organizationID: string): boolean {
    const organization = this.organizations.get(organizationID);
    if (
      organization === undefined ||
      !actor.isAlive() ||
      !isDiplomacyPlusParticipant(actor) ||
      organization.memberIDs.includes(actor.id())
    ) {
      return false;
    }
    organization.memberIDs = [...organization.memberIDs, actor.id()].sort();
    this.revision++;
    return true;
  }

  propose(
    proposer: Player,
    organizationID: string,
    kind: InternationalResolutionKind,
    target: Player,
    options: {
      beneficiaryID?: PlayerID;
      incidentID?: string;
      amount?: number;
    } = {},
  ): InternationalResolution | null {
    if (this.resolutions.size >= MAX_RESOLUTIONS) {
      const oldestClosed = [...this.resolutions.values()]
        .filter((resolution) => resolution.status !== "voting")
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldestClosed === undefined) return null;
      this.resolutions.delete(oldestClosed.id);
      this.revision++;
    }
    const organization = this.organizations.get(organizationID);
    if (
      organization === undefined ||
      !organization.memberIDs.includes(proposer.id()) ||
      proposer === target ||
      !target.isAlive() ||
      !isDiplomacyPlusParticipant(target)
    ) {
      return null;
    }
    if (options.incidentID !== undefined) {
      const incident = this.game.diplomaticIncident(options.incidentID);
      if (
        incident === null ||
        incident.offenderID !== target.id() ||
        (options.beneficiaryID !== undefined &&
          incident.victimID !== options.beneficiaryID)
      ) {
        return null;
      }
    }
    if (
      kind === "demand_reparations" &&
      (options.beneficiaryID === undefined ||
        !this.game.hasPlayer(options.beneficiaryID) ||
        !Number.isSafeInteger(options.amount) ||
        (options.amount ?? 0) < 1 ||
        (options.amount ?? 0) > 1_000_000)
    ) {
      return null;
    }
    const resolution: InternationalResolution = {
      id: `ir:${this.nextResolutionID++}`,
      organizationID,
      proposerID: proposer.id(),
      kind,
      targetID: target.id(),
      beneficiaryID: options.beneficiaryID,
      incidentID: options.incidentID,
      amount: options.amount,
      createdAt: this.game.ticks(),
      closesAt: this.game.ticks() + VOTING_DURATION_TICKS,
      status: "voting",
      votes: [],
    };
    this.resolutions.set(resolution.id, resolution);
    this.revision++;
    return resolution;
  }

  vote(
    voter: Player,
    resolutionID: string,
    choice: InternationalVoteChoice,
    reason: string,
  ): boolean {
    const resolution = this.resolutions.get(resolutionID);
    const organization =
      resolution === undefined
        ? undefined
        : this.organizations.get(resolution.organizationID);
    if (
      resolution === undefined ||
      organization === undefined ||
      resolution.status !== "voting" ||
      !voter.isAlive() ||
      !isDiplomacyPlusParticipant(voter) ||
      !organization.memberIDs.includes(voter.id()) ||
      resolution.votes.some((vote) => vote.voterID === voter.id())
    ) {
      return false;
    }
    resolution.votes.push({
      voterID: voter.id(),
      choice,
      reason: reason.slice(0, 160),
    });
    resolution.votes.sort((a, b) => a.voterID.localeCompare(b.voterID));
    this.revision++;
    const activeMembers = organization.memberIDs.filter(
      (memberID) =>
        this.game.hasPlayer(memberID) && this.game.player(memberID).isAlive(),
    );
    if (resolution.votes.length >= activeMembers.length) {
      this.resolve(resolution, organization);
    }
    return true;
  }

  tick(): void {
    for (const resolution of this.resolutions.values()) {
      if (
        resolution.status !== "voting" ||
        resolution.closesAt > this.game.ticks()
      )
        continue;
      const organization = this.organizations.get(resolution.organizationID);
      if (organization !== undefined) this.resolve(resolution, organization);
    }
  }

  hash(): number {
    return simpleHash(
      JSON.stringify({
        organizations: this.allOrganizations(),
        resolutions: [...this.resolutions.values()].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      }),
    );
  }

  private resolve(
    resolution: InternationalResolution,
    organization: InternationalOrganization,
  ): void {
    const votesFor = resolution.votes.filter((vote) => vote.choice === "for");
    const votesAgainst = resolution.votes.filter(
      (vote) => vote.choice === "against",
    );
    const activeMembers = organization.memberIDs.filter(
      (memberID) =>
        this.game.hasPlayer(memberID) && this.game.player(memberID).isAlive(),
    );
    const quorum = Math.max(1, Math.ceil(activeMembers.length / 2));
    resolution.status =
      votesFor.length + votesAgainst.length >= quorum &&
      votesFor.length > votesAgainst.length
        ? "passed"
        : "rejected";
    this.revision++;
    if (
      resolution.status !== "passed" ||
      !this.game.hasPlayer(resolution.targetID)
    )
      return;
    const target = this.game.player(resolution.targetID);
    target.changeReputation(-8);
    for (const vote of votesFor) {
      if (!this.game.hasPlayer(vote.voterID)) continue;
      const voter = this.game.player(vote.voterID);
      if (voter !== target) {
        voter.rememberDiplomaticEvent(
          target,
          "international_condemnation",
          -10,
          -5,
          { severity: 60 },
        );
      }
      if (voter !== target && resolution.kind === "collective_sanctions") {
        voter.addEmbargo(target, false);
      }
    }
    if (
      resolution.kind === "demand_reparations" &&
      resolution.beneficiaryID !== undefined &&
      resolution.amount !== undefined &&
      this.game.hasPlayer(resolution.beneficiaryID)
    ) {
      const beneficiary = this.game.player(resolution.beneficiaryID);
      this.game.createDiplomaticProposal(
        beneficiary,
        target,
        [
          {
            kind: "gold_reparations",
            payerID: target.id(),
            recipientID: beneficiary.id(),
            amount: resolution.amount,
            incidentID: resolution.incidentID,
          },
        ],
        undefined,
        [{ code: "international_condemnation", impact: 35 }],
      );
    }
  }
}

export function evaluateInternationalResolutionVote(
  game: Game,
  voter: Player,
  resolution: InternationalResolution,
): { choice: InternationalVoteChoice; reason: string } {
  const target = game.player(resolution.targetID);
  let score = voter.relationScore(target) * -0.4 + target.threat() * 0.35;
  if (resolution.incidentID !== undefined) {
    const incident = game.diplomaticIncident(resolution.incidentID);
    if (incident?.evidence === "confirmed") score += incident.severity * 0.55;
  }
  if (voter.isAlliedWith(target)) score -= 35;
  if (
    voter
      .tradeContracts()
      .some(
        (contract) =>
          contract.status === "active" &&
          (contract.buyerID === target.id() ||
            contract.sellerID === target.id()),
      )
  )
    score -= 12;
  if (score >= 20)
    return {
      choice: "for",
      reason: `Responsabilité et menace: ${Math.round(score)}`,
    };
  if (score <= -15)
    return {
      choice: "against",
      reason: `Partenariat stratégique: ${Math.round(score)}`,
    };
  return {
    choice: "abstain",
    reason: `Intérêts partagés: ${Math.round(score)}`,
  };
}
