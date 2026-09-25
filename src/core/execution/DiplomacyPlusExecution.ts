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
      if (this.action === "trade_agreement") {
        const accept =
          target.type() === PlayerType.Nation &&
          target.trust(this.actor) >= 45 &&
          target.relation(this.actor) !== Relation.Hostile &&
          target.canTrade(this.actor);
        if (accept) this.actor.setTradeAgreement(target);
        return;
      }
      if (
        this.action === "offer_white_peace" ||
        this.action === "demand_reparations"
      ) {
        const atWar =
          this.actor.isWarAuthorizedAgainst(target) ||
          target.isWarAuthorizedAgainst(this.actor) ||
          this.actor
            .outgoingAttacks()
            .some((attack) => attack.target() === target) ||
          target
            .outgoingAttacks()
            .some((attack) => attack.target() === this.actor);
        if (!atWar || target.type() !== PlayerType.Nation) return;
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
        }
        const leverage = this.actor.troops() / Math.max(1, target.troops());
        const exhausted =
          target.resources().food <= 0 || target.resources().fuel <= 0;
        if (this.action === "offer_white_peace") {
          if (leverage >= 0.8 || exhausted) {
            this.actor.concludePeaceWith(target, 1200);
          }
          return;
        }
        if (leverage >= 1.35 || (leverage >= 1 && exhausted)) {
          const reparations = target.removeGold(
            target.gold() < 500n ? target.gold() : 500n,
          );
          this.actor.addGold(reparations);
          this.actor.rememberDiplomaticEvent(target, "reparations_paid", 8, 6);
          target.rememberDiplomaticEvent(
            this.actor,
            "reparations_paid",
            -4,
            -2,
          );
          this.actor.concludePeaceWith(target, 1800);
        } else {
          this.actor.rememberDiplomaticEvent(
            target,
            "reparations_refused",
            -10,
            -10,
          );
          target.rememberDiplomaticEvent(
            this.actor,
            "reparations_refused",
            -5,
            -5,
          );
        }
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

      if (this.action === "offer_nap") {
        if (
          this.actor.isWarAuthorizedAgainst(target) ||
          target.isWarAuthorizedAgainst(this.actor)
        )
          return;
        if (
          this.actor.relation(target) === Relation.Hostile ||
          target.relation(this.actor) === Relation.Hostile
        )
          return;

        // Human-human offers need a reply UI later. Nations can evaluate immediately.
        let accept = target.type() === PlayerType.Nation;
        if (accept) {
          const hostilePressure =
            this.actor.threat() * 0.35 + (100 - this.actor.reputation()) * 0.25;
          accept =
            hostilePressure < 42 ||
            target.relation(this.actor) >= Relation.Friendly;
        }
        if (accept) {
          this.actor.setNonAggressionPact(target, 3600);
          this.actor.updateRelation(target, 10);
          target.updateRelation(this.actor, 10);
          this.actor.changeTrust(target, 10);
          target.changeTrust(this.actor, 10);
          this.actor.rememberDiplomaticEvent(target, "nap_signed", 10, 10);
          target.rememberDiplomaticEvent(this.actor, "nap_signed", 10, 10);
        }
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
      this.action === "economic_aid"
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
