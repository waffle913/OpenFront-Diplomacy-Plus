import { Execution, Game, Player } from "../game/Game";

export class DiplomaticIncidentExecution implements Execution {
  private game: Game | null = null;
  private active = true;

  constructor(
    private readonly actor: Player,
    private readonly action: "protest" | "dismiss",
    private readonly incidentID: string,
  ) {}

  init(game: Game): void {
    this.game = game;
    const incident = game.diplomaticIncident(this.incidentID);
    if (
      incident === null ||
      incident.victimID !== this.actor.id() ||
      !this.actor.isAlive()
    ) {
      this.active = false;
    }
  }

  tick(): void {
    if (!this.active || this.game === null) return;
    try {
      if (this.action === "protest") {
        this.game.protestDiplomaticIncident(this.actor, this.incidentID);
      } else {
        this.game.dismissDiplomaticIncident(this.actor, this.incidentID);
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
