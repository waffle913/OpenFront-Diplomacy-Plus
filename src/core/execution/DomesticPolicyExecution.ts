import { Execution, Game, Player, TaxPolicy } from "../game/Game";

export class DomesticPolicyExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private policy: TaxPolicy,
  ) {}

  init(_mg: Game): void {}

  tick(): void {
    if (!this.active) return;
    this.player.setTaxPolicy(this.policy);
    this.active = false;
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
