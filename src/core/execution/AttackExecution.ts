import { renderTroops } from "../../client/Utils";
import { AttackLogicInput } from "../configuration/Config";
import {
  Attack,
  CasusBelliType,
  Difficulty,
  Execution,
  Game,
  MessageType,
  Player,
  PlayerID,
  PlayerType,
  TerrainType,
  TerraNullius,
  UnitType,
  WORLD_FORMATION_UNLOCK_TICK,
} from "../game/Game";
import { GameMap, TileRef } from "../game/GameMap";
import { PseudoRandom } from "../PseudoRandom";
import { assertNever } from "../Util";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap"; // adjust path if needed

const malusForRetreat = 25;
export class AttackExecution implements Execution {
  private active: boolean = true;
  private toConquer = new FlatBinaryHeap();

  private random = new PseudoRandom(123);

  private target: Player | TerraNullius;

  private mg: Game;
  // Direct GameMap reference to skip the Game delegation hop in hot loops.
  private map: GameMap;

  private attack: Attack | null = null;

  // Diplomacy+ V1.9: territorial offensives are regional. The first
  // historical region entered becomes the concrete war objective. This avoids
  // arbitrary percentage caps that tended to stop wars halfway through a
  // region and manufacture accidental contested borders.
  private warGoal: CasusBelliType | null = null;
  private claimedRegionID: number | null = null;
  private claimedRegionTargetTilesRemaining = 0;

  // V1.13: hard operational boundary for every sovereign-vs-sovereign land
  // offensive. The first historical region actually entered by this charge
  // becomes its immutable operational region. A single AttackExecution may
  // never conquer a tile in another historical region.
  private operationalRegionID: number | null = null;

  // Cached smallIDs for integer owner comparisons in hot loops.
  private ownerSmallID: number;
  private targetSmallID: number;
  // Reusable neighbor buffers to avoid closures/allocation in hot loops.
  private nbuf: TileRef[] = [0, 0, 0, 0];
  private nbuf2: TileRef[] = [0, 0, 0, 0];

  constructor(
    private startTroops: number | null = null,
    private _owner: Player,
    private _targetID: PlayerID | null,
    private sourceTile: TileRef | null = null,
    private removeTroops: boolean = true,
    private requestedRegionID: number | null = null,
  ) {}

  public targetID(): PlayerID | null {
    return this._targetID;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number) {
    if (!this.active) {
      return;
    }
    this.mg = mg;
    this.map = mg.map();

    if (this._targetID !== null && !mg.hasPlayer(this._targetID)) {
      console.warn(`target ${this._targetID} not found`);
      this.active = false;
      return;
    }

    this.target =
      this._targetID === this.mg.terraNullius().id()
        ? mg.terraNullius()
        : mg.player(this._targetID);
    this.ownerSmallID = this._owner.smallID();
    this.targetSmallID = this.target.smallID();

    // V1.14: the caller may choose the political objective before combat.
    // This makes the region the cause/target of the offensive rather than
    // letting the first randomly reached tile decide it.
    if (this.target.isPlayer()) {
      // Once a territorial war has a declared region, later clicks cannot
      // silently move the war to another province. The first declaration
      // chooses it; subsequent offensives inherit it.
      const declaredRegion = this._owner.warGoalRegionAgainst(this.target);
      if (declaredRegion !== null) this.requestedRegionID = declaredRegion;
      if (this.requestedRegionID !== null) {
        this.operationalRegionID = this.requestedRegionID;
      }
    }

    if (
      !this.mg.inSpawnPhase() &&
      this.mg.ticksSinceStart() < WORLD_FORMATION_UNLOCK_TICK &&
      this.target.isPlayer()
    ) {
      this.active = false;
      return;
    }

    if (this._owner === this.target) {
      console.error(`Player ${this._owner} cannot attack itself`);
      this.active = false;
      return;
    }

    // ALLIANCE CHECK — block attacks on friendly (ally or same team)
    if (this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (this._owner.isFriendly(targetPlayer)) {
        console.warn(
          `${this._owner.displayName()} cannot attack ${targetPlayer.displayName()} because they are friendly (allied or same team)`,
        );
        this.active = false;
        return;
      }
    }

    if (this.target.isPlayer() && !this._owner.canAttackPlayer(this.target)) {
      // A landing already paid for these troops when the transport departed.
      if (this.sourceTile !== null && !this.removeTroops) {
        this._owner.addTroops(this.startTroops ?? 0);
      }
      this.active = false;
      return;
    }

    // Validate regional land assaults before committing troops or diplomacy.
    if (
      this.sourceTile === null &&
      this.target.isPlayer() &&
      this.requestedRegionID !== null
    ) {
      if (this.countRegionTiles(this.target, this.requestedRegionID) === 0) {
        if (
          this.target.type() !== PlayerType.Bot &&
          this._owner.isWarAuthorizedAgainst(this.target)
        ) {
          this._owner.concludePeaceWith(this.target, 1200);
        } else {
          this._owner.clearWarGoalRegionAgainst(this.target);
        }
        this.active = false;
        return;
      }
      if (!this.hasReachableBorderInRegion(this.requestedRegionID)) {
        this.active = false;
        return;
      }
    }

    this.startTroops ??= this.mg
      .config()
      .attackAmount(this._owner, this.target);

    // Strategic logistics are charged only after every territorial and treaty
    // validation has passed, but before troops or diplomatic state change.
    if (
      !this.mg.inSpawnPhase() &&
      this.mg.ticksSinceStart() >= WORLD_FORMATION_UNLOCK_TICK
    ) {
      const committed = Math.min(this._owner.troops(), this.startTroops);
      const foodCost = Math.min(10, Math.max(0.2, committed / 100_000));
      const fuelCost = Math.min(5, Math.max(0.1, committed / 200_000));
      const stocks = this._owner.resources();
      if (stocks.food < foodCost || stocks.fuel < fuelCost) {
        this.active = false;
        return;
      }
      this._owner.removeResource("food", foodCost);
      this._owner.removeResource("fuel", fuelCost);
    }

    if (this.target && this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (
        targetPlayer.type() !== PlayerType.Bot &&
        this._owner.type() !== PlayerType.Bot
      ) {
        // Don't let bots embargo since they can't trade anyway.
        targetPlayer.addEmbargo(this._owner, true);
        this.rejectIncomingAllianceRequests(targetPlayer);
      }
    }

    if (this.removeTroops) {
      this.startTroops = Math.min(this._owner.troops(), this.startTroops);
      // Take the amount that was actually deducted, not the amount asked for.
      // removeTroops() floors, so a fractional request leaves the attack
      // holding troops the owner never paid for — and retreat refunds the
      // combined total, turning the leftover fractions into free troops.
      this.startTroops = this._owner.removeTroops(this.startTroops);
    }
    this.attack = this._owner.createAttack(
      this.target,
      this.startTroops,
      this.sourceTile,
      new Set<TileRef>(),
    );

    if (this.sourceTile !== null) {
      this.addNeighbors(this.sourceTile);
    } else {
      this.refreshToConquer();
    }

    // Record stats
    this.mg.stats().attack(this._owner, this.target, this.startTroops);

    for (const incoming of this._owner.incomingAttacks()) {
      if (incoming.attacker() === this.target) {
        // Target has opposing attack, cancel them out
        if (incoming.troops() > this.attack.troops()) {
          incoming.setTroops(incoming.troops() - this.attack.troops());
          this.attack.delete();
          this.active = false;
          return;
        } else {
          this.attack.setTroops(this.attack.troops() - incoming.troops());
          incoming.delete();
        }
      }
    }
    for (const outgoing of this._owner.outgoingAttacks()) {
      if (
        outgoing !== this.attack &&
        outgoing.target() === this.attack.target() &&
        // Boat attacks (sourceTile is not null) are not combined with other attacks
        this.attack.sourceTile() === null
      ) {
        this.attack.setTroops(this.attack.troops() + outgoing.troops());
        outgoing.delete();
      }
    }

    // Only now is it known how large the attack the defender actually faces
    // is: a big assault is built by clicking repeatedly, and each click's
    // execution absorbs the earlier ones above. Recorded before the loops it
    // would measure one click, and would count an attack that cancelled out
    // and never landed.
    this.mg.stats().attackMaxIncoming(this.target, this.attack.troops());

    if (this.target.isPlayer()) {
      const targetPlayer = this.target;

      // Diplomacy+ V1.10: tribes are frontier actors, not sovereign states.
      // Expanding into a tribe should not make a Nation/Human internationally
      // notorious. Keep the combat itself unchanged, but skip the CB/Threat/Rep
      // machinery that is reserved for wars between sovereign states.
      if (
        targetPlayer.type() === PlayerType.Bot &&
        this._owner.type() !== PlayerType.Bot
      ) {
        this.warGoal = null;
      } else {
        const alreadyAtWar = this._owner.isWarAuthorizedAgainst(targetPlayer);
        const napExpiry = this._owner.nonAggressionPactWith(targetPlayer);
        if (!alreadyAtWar && napExpiry !== null) {
          this._owner.breakNonAggressionPact(targetPlayer);
          this._owner.changeThreat(25);
          this._owner.changeReputation(-25);
          targetPlayer.grantCasusBelli(
            this._owner,
            CasusBelliType.TreatyViolation,
            4800,
          );
        }
        const cb = alreadyAtWar
          ? null
          : this._owner.consumeCasusBelli(targetPlayer);
        const justified = alreadyAtWar || cb !== null;
        // The CB is consumed at war start, but PlayerImpl persists its type as
        // the war goal for the authorization's lifetime.
        const warGoal = this._owner.warGoalAgainst(targetPlayer);
        // Every sovereign land war gets a declared theatre. A CB determines
        // whether the war is justified; the clicked/chosen region determines
        // what territory this war is actually about. Even an unjustified war
        // therefore cannot quietly hop to another region on the next charge.
        if (
          this.requestedRegionID !== null &&
          this._owner.warGoalRegionAgainst(targetPlayer) === null
        ) {
          // consumeCasusBelli() has already authorized justified wars. For an
          // unjustified first strike authorization happens just below, so that
          // case is persisted immediately after authorizeWarAgainst().
          if (this._owner.isWarAuthorizedAgainst(targetPlayer)) {
            this._owner.setWarGoalRegionAgainst(
              targetPlayer,
              this.requestedRegionID,
            );
          }
        }
        if (
          targetPlayer.type() !== PlayerType.Bot &&
          this.requestedRegionID !== null
        ) {
          this.claimedRegionID = this.requestedRegionID;
          this._owner.setWarGoalRegionAgainst(
            targetPlayer,
            this.requestedRegionID,
          );
          let remaining = 0;
          for (const tile of targetPlayer.tiles()) {
            if (this.mg.historicalRegionAt(tile)?.id === this.requestedRegionID)
              remaining++;
          }
          this.claimedRegionTargetTilesRemaining = remaining;
        }

        if (!justified) {
          // War is never forbidden. An unjustified first strike simply carries
          // international consequences, then opens a temporary war state so
          // repeated clicks do not repeatedly apply the diplomatic penalty.
          this._owner.authorizeWarAgainst(targetPlayer, 1800, null);
          if (this.requestedRegionID !== null) {
            this._owner.setWarGoalRegionAgainst(
              targetPlayer,
              this.requestedRegionID,
            );
          }
          this._owner.changeThreat(20);
          this._owner.changeReputation(-15);

          // The victim always gains a retaliation CB. Other states react
          // individually: friends of the victim care more, friends of the
          // aggressor less. This is intentionally simple for Diplomacy V0.1.
          targetPlayer.grantCasusBelli(
            this._owner,
            CasusBelliType.Retaliation,
            2400,
          );
          // Guarantees turn aggression against a protected state into a direct
          // defensive CB for each guarantor.
          for (const observer of this.mg.players()) {
            if (observer === this._owner || observer === targetPlayer) continue;
            if (observer.guarantees(targetPlayer)) {
              observer.grantCasusBelli(
                this._owner,
                CasusBelliType.Containment,
                4800,
              );
              observer.updateRelation(this._owner, -30);
              targetPlayer.updateRelation(observer, 8);
            }
          }

          for (const observer of this.mg.players()) {
            if (observer === this._owner) continue;
            const extremeAggressor =
              this._owner.threat() >= 80 || this._owner.reputation() <= 20;
            const regionalConcern =
              this._owner.threat() >= 55 || this._owner.reputation() <= 45;
            const locallyRelevant =
              observer.sharesBorderWith(this._owner) ||
              observer.relation(this._owner) <= -25;
            if (
              observer.casusBelliAgainst(this._owner) === null &&
              (extremeAggressor || (regionalConcern && locallyRelevant))
            ) {
              observer.grantCasusBelli(
                this._owner,
                CasusBelliType.Containment,
                6000,
              );
            }
          }

          for (const observer of this.mg.players()) {
            if (observer === this._owner || observer === targetPlayer) continue;
            let reaction = -8;
            if (observer.relation(targetPlayer) >= 3) reaction -= 10;
            if (observer.relation(this._owner) >= 3) reaction += 5;
            observer.updateRelation(this._owner, reaction);
          }
        }

        if (!alreadyAtWar) {
          this._owner.changeTrust(targetPlayer, -10);
          targetPlayer.changeTrust(this._owner, -35);
          this._owner.rememberDiplomaticEvent(
            targetPlayer,
            "war_started",
            -10,
            -10,
          );
          targetPlayer.rememberDiplomaticEvent(
            this._owner,
            "war_started",
            -30,
            -35,
          );
        }

        this.warGoal = warGoal;
      }

      const difficulty = this.mg.config().gameConfig().difficulty;
      let relationChange: number;
      switch (difficulty) {
        case Difficulty.Easy:
          relationChange = -60;
          break;
        case Difficulty.Medium:
          relationChange = -70;
          break;
        case Difficulty.Hard:
          relationChange = -80;
          break;
        case Difficulty.Impossible:
          relationChange = -100;
          break;
        default:
          assertNever(difficulty);
      }
      this.target.updateRelation(this._owner, relationChange);
    }
  }

  private countRegionTiles(target: Player, regionID: number): number {
    let count = 0;
    for (const tile of target.tiles()) {
      if (this.mg.historicalRegionAt(tile)?.id === regionID) count++;
    }
    return count;
  }

  private hasReachableBorderInRegion(regionID: number): boolean {
    for (const border of this._owner.borderTiles()) {
      const count = this.map.neighbors4(border, this.nbuf);
      for (let i = 0; i < count; i++) {
        const tile = this.nbuf[i];
        if (
          this.map.ownerID(tile) === this.targetSmallID &&
          this.map.isLand(tile) &&
          !this.map.isImpassable(tile) &&
          this.mg.historicalRegionAt(tile)?.id === regionID
        )
          return true;
      }
    }
    return false;
  }

  private refreshToConquer() {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    this.toConquer.clear();
    this.attack.clearBorder();
    // forEach over the dense storage — the values() generator showed up in long-game profiles
    this._owner.borderTiles().forEach((tile) => this.addNeighbors(tile));
  }

  private retreat(malusPercent = 0) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const deaths = this.attack.troops() * (malusPercent / 100);
    if (deaths) {
      this.mg.displayMessage(
        "events_display.attack_cancelled_retreat",
        MessageType.ATTACK_CANCELLED,
        this._owner.id(),
        undefined,
        { troops: renderTroops(deaths) },
      );
    }
    if (this.removeTroops === false && this.sourceTile === null) {
      // startTroops are always added to attack troops at init but not always removed from owner troops
      // subtract startTroops from attack troops so we don't give back startTroops to owner that were never removed
      // boat attacks (sourceTile !== null) are the exception: troops were removed at departure and must be returned after attack still
      this.attack.setTroops(this.attack.troops() - (this.startTroops ?? 0));
    }

    const survivors = this.attack.troops() - deaths;
    this._owner.addTroops(survivors);
    this.attack.delete();
    this.active = false;

    // Not all retreats are canceled attacks
    if (this.attack.retreated()) {
      // Record stats
      this.mg.stats().attackCancel(this._owner, this.target, survivors);
    }
  }

  tick(ticks: number) {
    if (
      !this.mg.inSpawnPhase() &&
      this.mg.ticksSinceStart() >= 200 &&
      this.mg.ticksSinceStart() < WORLD_FORMATION_UNLOCK_TICK
    )
      return;
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }
    let troopCount = this.attack.troops(); // cache troop count
    const targetIsPlayer = this.target.isPlayer(); // cache target type
    const targetPlayer = targetIsPlayer ? (this.target as Player) : null; // cache target player

    if (this.attack.retreated()) {
      if (targetIsPlayer) {
        this.retreat(malusForRetreat);
      } else {
        this.retreat();
      }
      this.active = false;
      return;
    }

    if (this.attack.retreating()) {
      return;
    }

    if (!this.attack.isActive()) {
      this.active = false;
      return;
    }

    if (targetPlayer && this._owner.isFriendly(targetPlayer)) {
      // In this case a new alliance was created AFTER the attack started.
      this.retreat();
      return;
    }

    // Peace also stops charges already in flight on either side.
    if (
      targetPlayer &&
      (this._owner.truceWith(targetPlayer) !== null ||
        (this._owner.nonAggressionPactWith(targetPlayer) !== null &&
          !this._owner.isWarAuthorizedAgainst(targetPlayer)))
    ) {
      this.retreat();
      return;
    }
    // Recount once per tick: other offensives can capture or restore tiles.
    if (
      targetPlayer &&
      targetPlayer.type() !== PlayerType.Bot &&
      this.claimedRegionID !== null
    ) {
      this.claimedRegionTargetTilesRemaining = this.countRegionTiles(
        targetPlayer,
        this.claimedRegionID,
      );
      if (this.claimedRegionTargetTilesRemaining === 0) {
        this._owner.concludePeaceWith(targetPlayer, 1200);
        this.retreat();
        return;
      }
    }

    const borderSize = this.attack.borderSize() + this.random.nextInt(0, 5);
    // Each tile consumes a fraction of the tick; conquer until it is spent.
    let tickBudget = 1;

    while (tickBudget > 0) {
      if (troopCount < 1) {
        this.attack.delete();
        this.active = false;
        return;
      }

      if (this.toConquer.size() === 0) {
        this.refreshToConquer();
        this.retreat();
        return;
      }

      const tileToConquer = this.toConquer.dequeue();
      this.attack.removeBorderTile(tileToConquer);

      let onBorder = false;
      const numNeighbors = this.map.neighbors4(tileToConquer, this.nbuf);
      for (let i = 0; i < numNeighbors; i++) {
        if (this.map.ownerID(this.nbuf[i]) === this.ownerSmallID) {
          onBorder = true;
          break;
        }
      }
      if (this.map.ownerID(tileToConquer) !== this.targetSmallID || !onBorder) {
        continue;
      }
      if (
        !this.map.isLand(tileToConquer) ||
        this.map.isImpassable(tileToConquer)
      ) {
        continue;
      }

      // V1.13 HARD REGIONAL FRONTIER. This sits immediately before combat and
      // Player.conquer(), so it constrains the actual tile-capture path rather
      // than diplomacy/AI target selection. This applies to every player-owned
      // target, including tribes, so the rule can be tested consistently.
      if (targetPlayer) {
        const region = this.mg.historicalRegionAt(tileToConquer);
        if (region !== null) {
          if (this.operationalRegionID === null) {
            this.operationalRegionID = region.id;
          } else if (region.id !== this.operationalRegionID) {
            // Do not capture across the black historical border. Other queued
            // tiles may still belong to this offensive's region, so skip only
            // this tile instead of cancelling the whole attack immediately.
            continue;
          }
        } else if (this.operationalRegionID !== null) {
          // Once a charge is region-bound, unclassified land cannot be used as
          // a bridge around the frontier.
          continue;
        }
      }

      // Territorial offensives are regional, not a licence to annex the
      // entire enemy. Border claims and containment both bind themselves to
      // the first historical region actually entered. From then on this
      // execution can only advance inside that immutable region.
      if (targetPlayer && targetPlayer.type() !== PlayerType.Bot) {
        const region = this.mg.historicalRegionAt(tileToConquer);
        if (this.claimedRegionID === null) {
          if (region !== null) {
            this.claimedRegionID = region.id;
            this._owner.setWarGoalRegionAgainst(targetPlayer, region.id);
            let remaining = 0;
            for (const tile of targetPlayer.tiles()) {
              if (this.mg.historicalRegionAt(tile)?.id === region.id)
                remaining++;
            }
            this.claimedRegionTargetTilesRemaining = remaining;
          }
        } else if (region?.id !== this.claimedRegionID) {
          continue;
        }
      }

      this.addNeighbors(tileToConquer);
      const { attackerTroopLoss, defenderTroopLoss, tickFraction } = this.mg
        .config()
        .attackLogic(
          this.attackLogicInput(troopCount, tileToConquer, borderSize),
        );
      tickBudget -= tickFraction;
      troopCount -= attackerTroopLoss;
      this.attack.setTroops(troopCount);
      if (targetPlayer) {
        targetPlayer.removeTroops(defenderTroopLoss);
      }
      this._owner.conquer(tileToConquer);

      if (
        targetPlayer &&
        targetPlayer.type() !== PlayerType.Bot &&
        this.claimedRegionID !== null
      ) {
        this.claimedRegionTargetTilesRemaining = Math.max(
          0,
          this.claimedRegionTargetTilesRemaining - 1,
        );
        // The target no longer controls any tile of the claimed region: the
        // territorial war goal is fulfilled, so stop instead of blob-conquering.
        if (this.claimedRegionTargetTilesRemaining === 0) {
          // V1.15: fulfilling the declared regional objective ends the war rather
          // than merely ending this charge. The victor keeps conquered land;
          // both states receive a temporary truce so the AI cannot instantly
          // restart the same conflict.
          this._owner.changeThreat(-2);
          this._owner.changeReputation(2);
          this._owner.concludePeaceWith(targetPlayer, 1200);
          this.retreat();
          return;
        }
      }

      this.handleDeadDefender();
    }
  }

  private attackLogicInput(
    attackTroops: number,
    tile: TileRef,
    borderSize: number,
  ): AttackLogicInput {
    const defender = this.target.isPlayer() ? this.target : null;
    // Same test as scanning nearbyUnits() for a post owned by the defender
    // (active, not under construction, within range), without building a
    // result array per conquered tile — this runs for every tile of every
    // attack on the map.
    const defenderHasDefensePost =
      defender !== null &&
      this.mg.hasUnitNearby(
        tile,
        this.mg.config().defensePostRange(),
        UnitType.DefensePost,
        defender.id(),
      );
    return {
      terrain: this.map.terrainType(tile),
      attackTroops,
      attacker: {
        type: this._owner.type(),
        numTiles: this._owner.numTilesOwned(),
      },
      defender:
        defender === null
          ? null
          : {
              type: defender.type(),
              numTiles: defender.numTilesOwned(),
              troops: defender.troops(),
              isTraitor: defender.isTraitor(),
              isDisconnectedTeammate:
                defender.isDisconnected() && this._owner.isOnSameTeam(defender),
            },
      defenderHasDefensePost,
      falloutRatio: this.mg.hasFallout(tile)
        ? this.mg.numTilesWithFallout() / this.mg.numLandTiles()
        : null,
      borderSize,
    };
  }

  private rejectIncomingAllianceRequests(target: Player) {
    const request = this._owner
      .incomingAllianceRequests()
      .find((ar) => ar.requestor() === target);
    if (request !== undefined) {
      request.reject();
    }
  }

  private addNeighbors(tile: TileRef) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const tickNow = this.mg.ticks(); // cache tick

    const numNeighbors = this.map.neighbors4(tile, this.nbuf);
    for (let i = 0; i < numNeighbors; i++) {
      const neighbor = this.nbuf[i];
      if (
        this.map.isWater(neighbor) ||
        this.map.isImpassable(neighbor) ||
        this.map.ownerID(neighbor) !== this.targetSmallID
      ) {
        continue;
      }
      // V1.13: once this charge has entered a historical region, never even
      // enqueue enemy tiles across another regional frontier. The pre-conquer
      // guard above remains as the authoritative safety check.
      if (
        this.operationalRegionID !== null &&
        this.target.isPlayer() &&
        this.mg.historicalRegionAt(neighbor)?.id !== this.operationalRegionID
      ) {
        continue;
      }

      // Once a regional war has selected its objective, every later charge is
      // seeded only from border tiles inside that region. This prevents a new
      // AttackExecution from wandering into a different province.
      if (
        this.claimedRegionID !== null &&
        this.target.isPlayer() &&
        this.target.type() !== PlayerType.Bot &&
        this.mg.historicalRegionAt(neighbor)?.id !== this.claimedRegionID
      ) {
        continue;
      }
      this.attack.addBorderTile(neighbor);
      let numOwnedByMe = 0;
      const numInner = this.map.neighbors4(neighbor, this.nbuf2);
      for (let j = 0; j < numInner; j++) {
        if (this.map.ownerID(this.nbuf2[j]) === this.ownerSmallID) {
          numOwnedByMe++;
        }
      }

      let mag: number;
      switch (this.map.terrainType(neighbor)) {
        case TerrainType.Plains:
          mag = 1;
          break;
        case TerrainType.Highland:
          mag = 1.5;
          break;
        case TerrainType.Mountain:
          mag = 2;
          break;
        default:
          mag = 0;
          break;
      }

      const priority =
        (this.random.nextInt(0, 7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) +
        tickNow;

      this.toConquer.enqueue(neighbor, priority);
    }
  }

  private handleDeadDefender() {
    // V1.13: vanilla's low-tile defender cleanup directly conquers remaining
    // territory and bypasses AttackExecution's tile frontier checks. Never run
    // that cleanup from a region-bound sovereign offensive. Let a later
    // offensive deal with another region explicitly.
    if (this.operationalRegionID !== null && this.target.isPlayer()) {
      return;
    }

    if (
      this.warGoal === CasusBelliType.Containment &&
      this.claimedRegionID !== null
    ) {
      // A regional containment war must never roll over into automatic total
      // annexation after its target region has been secured.
      if (this.target.isPlayer() && this.target.numTilesOwned() < 100) {
        this.retreat();
      }
      return;
    }
    if (!(this.target.isPlayer() && this.target.numTilesOwned() < 100)) return;
    const target: Player = this.target;

    this.mg.conquerPlayer(this._owner, target);

    const MAX_PASSES = 100;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let progressed = false;
      for (const tile of target.tiles()) {
        let borders = false;
        this.mg.forEachNeighbor(tile, (t) => {
          if (!borders && this.mg.owner(t) === this._owner) {
            borders = true;
          }
        });
        if (borders) {
          this._owner.conquer(tile);
          progressed = true;
        } else {
          let captured = false;
          this.mg.forEachNeighbor(tile, (neighbor) => {
            if (captured) return;
            const no = this.mg.owner(neighbor);
            if (no.isPlayer() && no !== target && !no.isFriendly(target)) {
              this.mg.player(no.id()).conquer(tile);
              captured = true;
            }
          });
          if (captured) progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  owner(): Player {
    return this._owner;
  }

  isActive(): boolean {
    return this.active;
  }
}
