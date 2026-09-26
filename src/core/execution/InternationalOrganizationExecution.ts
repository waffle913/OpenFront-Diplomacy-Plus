import {
  Execution,
  Game,
  InternationalCharterPrinciple,
  InternationalResolutionKind,
  InternationalVoteChoice,
  isDiplomacyPlusParticipant,
  Player,
  PlayerID,
} from "../game/Game";

export type InternationalOrganizationAction =
  | "create"
  | "join"
  | "propose"
  | "vote";

export interface InternationalOrganizationIntentData {
  name?: string;
  memberIDs?: PlayerID[];
  principles?: InternationalCharterPrinciple[];
  organizationID?: string;
  resolutionID?: string;
  resolutionKind?: InternationalResolutionKind;
  targetID?: PlayerID;
  beneficiaryID?: PlayerID;
  incidentID?: string;
  amount?: number;
  vote?: InternationalVoteChoice;
  reason?: string;
}

export class InternationalOrganizationExecution implements Execution {
  private game: Game | null = null;
  private active = true;

  constructor(
    private readonly actor: Player,
    private readonly action: InternationalOrganizationAction,
    private readonly data: InternationalOrganizationIntentData,
  ) {}

  init(game: Game): void {
    this.game = game;
    if (!this.actor.isAlive() || !isDiplomacyPlusParticipant(this.actor)) {
      this.active = false;
    }
  }

  tick(): void {
    if (!this.active || this.game === null) return;
    try {
      if (this.action === "create") {
        if (!this.data.name || !this.data.principles) return;
        const members = (this.data.memberIDs ?? [])
          .filter((id) => this.game!.hasPlayer(id))
          .map((id) => this.game!.player(id));
        this.game.createInternationalOrganization(
          this.actor,
          this.data.name,
          members,
          this.data.principles,
        );
      } else if (this.action === "join") {
        if (this.data.organizationID)
          this.game.proposeInternationalResolution(
            this.actor,
            this.data.organizationID,
            "admit_member",
            this.actor,
          );
      } else if (this.action === "propose") {
        if (
          !this.data.organizationID ||
          !this.data.resolutionKind ||
          !this.data.targetID ||
          !this.game.hasPlayer(this.data.targetID)
        )
          return;
        this.game.proposeInternationalResolution(
          this.actor,
          this.data.organizationID,
          this.data.resolutionKind,
          this.game.player(this.data.targetID),
          {
            beneficiaryID: this.data.beneficiaryID,
            incidentID: this.data.incidentID,
            amount: this.data.amount,
          },
        );
      } else if (this.data.resolutionID && this.data.vote) {
        this.game.voteInternationalResolution(
          this.actor,
          this.data.resolutionID,
          this.data.vote,
          this.data.reason ?? "Vote du gouvernement",
        );
      }
    } finally {
      this.active = false;
    }
  }

  applyDuringPause(): boolean {
    return true;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
