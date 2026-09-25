import {
  DiplomaticTerm,
  Execution,
  Game,
  isDiplomacyPlusParticipant,
  Player,
  PlayerID,
} from "../game/Game";

export type DiplomaticProposalAction =
  | "create"
  | "accept"
  | "reject"
  | "withdraw"
  | "counter";

export class DiplomaticProposalExecution implements Execution {
  private game: Game | null = null;
  private active = true;

  constructor(
    private readonly actor: Player,
    private readonly action: DiplomaticProposalAction,
    private readonly targetID?: PlayerID,
    private readonly proposalID?: string,
    private readonly terms: DiplomaticTerm[] = [],
  ) {}

  init(game: Game): void {
    this.game = game;
    if (!isDiplomacyPlusParticipant(this.actor) || !this.actor.isAlive()) {
      this.active = false;
      return;
    }
    if (
      this.action === "create" &&
      (this.targetID === undefined ||
        !game.hasPlayer(this.targetID) ||
        !isDiplomacyPlusParticipant(game.player(this.targetID)))
    ) {
      this.active = false;
    }
    if (this.action !== "create" && this.proposalID === undefined) {
      this.active = false;
    }
  }

  tick(): void {
    if (!this.active || this.game === null) return;
    try {
      if (this.action === "create") {
        this.game.createDiplomaticProposal(
          this.actor,
          this.game.player(this.targetID!),
          this.terms,
        );
      } else if (this.action === "accept") {
        this.game.acceptDiplomaticProposal(this.actor, this.proposalID!);
      } else if (this.action === "reject") {
        this.game.rejectDiplomaticProposal(this.actor, this.proposalID!);
      } else if (this.action === "withdraw") {
        this.game.withdrawDiplomaticProposal(this.actor, this.proposalID!);
      } else {
        this.game.counterDiplomaticProposal(
          this.actor,
          this.proposalID!,
          this.terms,
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
