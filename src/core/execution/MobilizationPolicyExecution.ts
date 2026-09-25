import { Execution, Game, Player } from "../game/Game";

export class MobilizationPolicyExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private percent: number,
  ) {}

  init(_mg: Game): void {}

  tick(): void {
    if (!this.active) return;
    this.player.setMobilizationTarget(this.percent);
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
