import {
  Execution,
  Game,
  isDiplomacyPlusParticipant,
  Player,
  PlayerID,
  PlayerType,
  Relation,
} from "../game/Game";

export type DiplomacyPlusAction =
  | "offer_nap"
  | "guarantee"
  | "withdraw_guarantee"
  | "ultimatum"
  | "economic_aid"
  | "joint_project"
  | "trade_agreement"
  | "offer_white_peace"
  | "demand_reparations"
  | "offer_concession"
  | "mediate_crisis";

export class DiplomacyPlusExecution implements Execution {
  private mg: Game | null = null;
  private active = true;
  constructor(
    private actor: Player,
    private targetID: PlayerID,
    private action: DiplomacyPlusAction,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    if (!isDiplomacyPlusParticipant(this.actor)) {
      this.active = false;
      return;
    }
    // A request already waiting for the next simulation tick is not sent twice.
    if (
      mg
        .executions()
        .some(
          (e) =>
            e !== this &&
            e instanceof DiplomacyPlusExecution &&
            e.isActive() &&
            e.actor === this.actor &&
            e.targetID === this.targetID &&
            e.action === this.action,
        )
    ) {
      this.active = false;
    }
    if (
      !mg.hasPlayer(this.targetID) ||
      !isDiplomacyPlusParticipant(mg.player(this.targetID))
    ) {
      this.active = false;
    }
  }

  tick(_ticks: number): void {
    if (!this.active || !this.mg) return;
    if (!this.mg.hasPlayer(this.targetID)) {
      this.active = false;
      return;
    }
    const target = this.mg.player(this.targetID);
    if (target === this.actor || !target.isAlive()) {
      this.active = false;
      return;
    }

    try {
      if (this.action === "offer_nap") {
        this.mg.createDiplomaticProposal(this.actor, target, [
          { kind: "non_aggression_pact", durationTicks: 3600 },
        ]);
        return;
      }
      if (this.action === "trade_agreement") {
        this.mg.createDiplomaticProposal(this.actor, target, [
          { kind: "trade_agreement", durationTicks: 3600 },
        ]);
        return;
      }
      if (this.action === "offer_white_peace") {
        this.mg.createDiplomaticProposal(this.actor, target, [
          { kind: "end_war", truceTicks: 1200 },
        ]);
        return;
      }
      if (this.action === "demand_reparations") {
        this.actor.rememberDiplomaticEvent(
          target,
          "reparations_requested",
          -2,
          -2,
        );
        target.rememberDiplomaticEvent(
          this.actor,
          "reparations_requested",
          -8,
          -8,
        );
        this.mg.createDiplomaticProposal(this.actor, target, [
          {
            kind: "gold_reparations",
            payerID: target.id(),
            recipientID: this.actor.id(),
            amount: 500,
          },
          { kind: "end_war", truceTicks: 1800 },
        ]);
        return;
      }
      if (this.action === "guarantee") {
        if (this.actor.guarantees(target)) return;
        this.actor.setGuarantee(target, true);
        this.actor.updateRelation(target, 8);
        target.updateRelation(this.actor, 8);
        return;
      }
      if (this.action === "withdraw_guarantee") {
        this.actor.setGuarantee(target, false);
        return;
      }
      if (this.action === "economic_aid") {
        this.actor.provideEconomicAid(target, 500n);
        return;
      }
      if (this.action === "joint_project") {
        const accept =
          target.type() === PlayerType.Nation &&
          target.trust(this.actor) >= 45 &&
          target.relation(this.actor) !== Relation.Hostile;
        if (accept) this.actor.launchJointProject(target);
        return;
      }
      if (this.action === "offer_concession") {
        this.actor.offerCrisisConcession(target);
        return;
      }
      if (this.action === "mediate_crisis") {
        this.actor.mediateCrisisInvolving(target);
        return;
      }

      if (this.action === "ultimatum") {
        this.actor.startDiplomaticCrisis(target);
      }
    } finally {
      // Diplomacy actions are one-shot executions, matching EmbargoExecution
      // and TargetPlayerExecution.
      this.active = false;
    }
  }

  applyDuringPause(): boolean {
    return (
      this.action === "guarantee" ||
      this.action === "withdraw_guarantee" ||
      this.action === "economic_aid" ||
      this.action === "offer_nap" ||
      this.action === "trade_agreement" ||
      this.action === "offer_white_peace" ||
      this.action === "demand_reparations"
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
