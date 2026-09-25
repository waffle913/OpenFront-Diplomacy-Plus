import {
  CasusBelliType,
  Difficulty,
  Game,
  GameMode,
  GameType,
  HumansVsNations,
  Player,
  PlayerID,
  PlayerType,
  Relation,
  Structures,
  TerraNullius,
  UnitType,
  WORLD_FORMATION_END_TICK,
} from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { canBuildTransportShip } from "../../game/TransportShipUtils";
import { PseudoRandom } from "../../PseudoRandom";
import {
  assertNever,
  boundingBoxCenter,
  calculateBoundingBoxCenter,
} from "../../Util";
import { AttackExecution } from "../AttackExecution";
import { DonateTroopsExecution } from "../DonateTroopExecution";
import { NationAllianceBehavior } from "../nation/NationAllianceBehavior";
import {
  EMOJI_ASSIST_ACCEPT,
  EMOJI_ASSIST_RELATION_TOO_LOW,
  EMOJI_ASSIST_TARGET_ALLY,
  EMOJI_ASSIST_TARGET_ME,
  NationEmojiBehavior,
} from "../nation/NationEmojiBehavior";
import { findJuiciestTarget } from "../nation/NationUtils";
import { TransportShipExecution } from "../TransportShipExecution";
import { closestTwoTiles } from "../Util";

// Reusable neighbor buffer for hot loops; the simulation is single-threaded.
const NEIGHBOR_SCRATCH: TileRef[] = [0, 0, 0, 0];

export class AiAttackBehavior {
  private botAttackTroopsSent: number = 0;
  // Diplomacy+ V1.0: foreign policy has its own clock.
  private lastDiplomaticReviewTick = -10_000;

  constructor(
    private random: PseudoRandom,
    private game: Game,
    private player: Player,
    private triggerRatio: number,
    private reserveRatio: number,
    private expandRatio: number,
    private allianceBehavior?: NationAllianceBehavior,
    private emojiBehavior?: NationEmojiBehavior,
  ) {}

  maybeAttack() {
    if (this.player === null || this.allianceBehavior === undefined) {
      throw new Error("not initialized");
    }

    // WORLD FORMATION: Nations keep only their spawn/capital territory while
    // tribes fill the Wild. Interstate war is separately locked until the
    // final regional snapshot has completed.
    if (!this.game.inSpawnPhase() && this.game.ticksSinceStart() < WORLD_FORMATION_END_TICK) {
      if (this.player.type() === PlayerType.Nation) return;
      this.sendAttack(this.game.terraNullius());
      return;
    }

    this.reviewDiplomaticAgenda();
    this.reviewTreatiesAndGuarantees();

    // Neighbor visit order matters here: the set's insertion order feeds the
    // stable troop-count sort below, so ties keep border-discovery order.
    const borderingPlayerSet = new Set<Player>();
    let borderHasNonNukedTerraNullius = false;
    const smallID = this.player.smallID();
    const visit = (t: number) => {
      if (!this.game.isLand(t) || this.game.isImpassable(t)) return;
      if (this.game.ownerID(t) === smallID) return;
      const owner = this.game.playerBySmallID(this.game.ownerID(t));
      if (owner.isPlayer()) borderingPlayerSet.add(owner);
      if (!this.game.hasOwner(t) && !this.game.hasFallout(t)) {
        borderHasNonNukedTerraNullius = true;
      }
    };
    // forEach, not for..of: TileSet.values() is a generator.
    this.player.borderTiles().forEach((t) => {
      this.game.forEachNeighbor(t, visit);
    });
    const playerNeighbors = this.player.nearby();
    for (const n of playerNeighbors) {
      if (n.isPlayer()) borderingPlayerSet.add(n);
    }
    const borderingPlayers = [...borderingPlayerSet].sort(
      (a, b) => a.troops() - b.troops(),
    );
    const borderingFriends = borderingPlayers.filter(
      (o) => this.player?.isFriendly(o) === true,
    );
    const borderingEnemies = borderingPlayers.filter(
      (o) => this.player?.isFriendly(o) === false,
    );

    // Attack TerraNullius but not nuked territory (direct border or across a river)
    const hasNonNukedTerraNullius =
      borderHasNonNukedTerraNullius ||
      playerNeighbors.some((n) => !n.isPlayer());
    if (hasNonNukedTerraNullius) {
      if (this.sendAttack(this.game.terraNullius())) return;
    }

    if (borderingEnemies.length === 0) {
      if (this.random.chance(5)) {
        this.attackWithRandomBoat();
      }
    } else {
      if (this.random.chance(10)) {
        this.attackWithRandomBoat(borderingEnemies);
        return;
      }

      this.allianceBehavior.maybeSendAllianceRequests(borderingEnemies);
    }

    this.attackBestTarget(borderingFriends, borderingEnemies);
  }

  private attackWithRandomBoat(borderingEnemies: Player[] = []) {
    if (this.player === null) throw new Error("not initialized");

    if (this.game.config().isUnitDisabled(UnitType.TransportShip)) {
      return;
    }

    // Check if we've already sent out the maximum number of transport ships
    if (
      this.player.unitCount(UnitType.TransportShip) >=
      this.game.config().boatMaxNumber()
    ) {
      return;
    }

    // Check if we have any shore tiles to launch from
    const shore = this.shoreTiles(this.player);
    if (shore.length === 0) {
      return;
    }

    const src = this.random.randElement(shore);

    // First look for high-interest targets (unowned or bot-owned). Mainly relevant for earlygame
    let dst = this.findRandomBoatTarget(src, borderingEnemies, true);
    if (dst === null) {
      // None found? Then look for players
      dst = this.findRandomBoatTarget(src, borderingEnemies, false);
      if (dst === null) {
        return;
      }
    }

    const owner = this.game.owner(dst);
    const cap = owner.isPlayer()
      ? this.troopSendCap()
      : this.troopSendCapForExpansion();
    const troops = Math.min(this.player.troops() / 5, cap);
    if (troops < 1) return;

    // Hard & Impossible: don't attack if we'd send less than 20% of target's troops
    if (owner.isPlayer() && this.isAttackTooWeak(troops, owner)) {
      return;
    }

    this.game.addExecution(
      new TransportShipExecution(this.player, dst, troops),
    );
  }

  private findRandomBoatTarget(
    tile: TileRef,
    borderingEnemies: Player[],
    highInterestOnly: boolean = false,
  ): TileRef | null {
    if (this.player === null) throw new Error("not initialized");
    const x = this.game.x(tile);
    const y = this.game.y(tile);
    const unreachablePlayers = new Set<PlayerID>();
    for (let i = 0; i < 500; i++) {
      const randX = this.random.nextInt(x - 150, x + 150);
      const randY = this.random.nextInt(y - 150, y + 150);
      if (!this.game.isValidCoord(randX, randY)) {
        continue;
      }
      const randTile = this.game.ref(randX, randY);
      if (!this.game.isLand(randTile)) {
        continue;
      }
      if (this.game.isImpassable(randTile)) {
        continue;
      }
      const owner = this.game.owner(randTile);
      if (owner === this.player) {
        continue;
      }
      // Skip players we already know are unreachable (Performance optimization)
      if (owner.isPlayer() && unreachablePlayers.has(owner.id())) {
        continue;
      }
      // Don't send boats to players with which we share a border, that usually looks stupid
      if (owner.isPlayer() && borderingEnemies.includes(owner)) {
        continue;
      }
      // Don't spam boats into players which are stronger than us (FFA only)
      if (
        this.isFFA() &&
        owner.isPlayer() &&
        owner.troops() > this.player.troops()
      ) {
        continue;
      }

      let matchesCriteria: boolean;
      if (highInterestOnly) {
        // High-interest targeting: prioritize unowned tiles or tiles owned by bots.
        matchesCriteria = !owner.isPlayer() || owner.type() === PlayerType.Bot;
      } else {
        // Diplomacy+ V0.5: long-range expeditions should have a political reason
        // more often than not. Aggressive / disreputable states are attractive
        // containment targets; peaceful neutral states are only selected
        // opportunistically. Existing CBs and authorized wars always qualify.
        if (owner.isPlayer() && !owner.isFriendly(this.player)) {
          const hasReason =
            this.player.isWarAuthorizedAgainst(owner) ||
            this.player.casusBelliAgainst(owner) !== null ||
            this.player.relation(owner) === Relation.Hostile;
          matchesCriteria = hasReason;
        } else {
          matchesCriteria = !owner.isPlayer();
        }
      }
      if (!matchesCriteria) {
        continue;
      }

      // Validate that we can actually build a transport ship to this target
      if (canBuildTransportShip(this.game, this.player, randTile) === false) {
        if (owner.isPlayer()) {
          unreachablePlayers.add(owner.id());
        }
        continue;
      }

      return randTile;
    }
    return null;
  }

  // attackBestTarget is called with borderingFriends and borderingEnemies sorted by troops (ascending)
  private attackBestTarget(
    borderingFriends: Player[],
    borderingEnemies: Player[],
  ) {
    // In games with high starting gold, nations will quickly build a lot of cities
    // This causes them to expand slowly (cities increase max troops), and bots will steal their structures
    // In this case: Attack bots before ratio checks
    if (this.hasNeighboringBotWithStructures()) {
      if (this.attackBots()) return;
    }

    // Save up troops until we reach the reserve ratio
    if (!this.hasReserveRatioTroops()) return;

    // Maybe save up troops until we reach the trigger ratio
    if (!this.hasTriggerRatioTroops() && !this.random.chance(10)) return;

    // Get attack strategies in priority order based on difficulty
    const strategies = this.getAttackStrategies(
      borderingFriends,
      borderingEnemies,
    );

    for (const strategy of strategies) {
      if (strategy()) return;
    }
  }

  private getAttackStrategies(
    borderingFriends: Player[],
    borderingEnemies: Player[],
  ): Array<() => boolean> {
    const { difficulty } = this.game.config().gameConfig();

    // Define all strategies as functions that return true if they attacked
    const retaliate = (): boolean => {
      const attacker = this.findIncomingAttackPlayer();
      if (attacker) {
        return this.sendAttack(attacker, true);
      }
      return false;
    };

    const bots = (): boolean => this.attackBots();

    const assist = (): boolean => this.assistAllies();

    // Diplomacy+ V0.6: diplomacy now creates strategic objectives instead of
    // merely decorating a target selected by the vanilla military AI. A nation
    // can deliberately redirect its war effort toward a dangerous / infamous
    // power, even when a weaker local victim exists.
    const political = (): boolean => {
      const target = this.findPoliticalTarget();
      if (target === null) return false;
      // Do not make every nation dogpile every tick. Political pressure is a
      // strong preference, not an unconditional command.
      if (!this.random.chance(3)) return false;
      return this.sendAttack(target);
    };

    const traitor = (): boolean => {
      const traitor = this.findTraitor(borderingEnemies);
      if (traitor) {
        return this.sendAttack(traitor);
      }
      return false;
    };

    const afk = (): boolean => {
      // borderingEnemies is already sorted by troops (ascending), so first match is weakest afk enemy
      const afk = borderingEnemies.find(
        (enemy) =>
          enemy.isDisconnected() &&
          (!this.isFFA() || enemy.troops() < this.player.troops() * 3),
      );
      if (afk) {
        return this.sendAttack(afk);
      }
      return false;
    };

    const betray = (): boolean =>
      this.maybeBetrayAndAttack(borderingFriends, borderingEnemies);

    const nuked = (): boolean => {
      if (this.isBorderingNukedTerritory()) {
        return this.sendAttack(this.game.terraNullius());
      }
      return false;
    };

    const victim = (): boolean => {
      const victim = this.findVictim(borderingEnemies);
      if (victim) {
        return this.sendAttack(victim);
      }
      return false;
    };

    const juicy = (): boolean => {
      const target = this.findJuicyTarget(borderingEnemies);
      return target !== null ? this.sendAttack(target) : false;
    };

    const hated = (): boolean => {
      for (const relation of this.player.allRelationsSorted()) {
        if (relation.relation !== Relation.Hostile) continue;
        const other = relation.player;
        if (this.player.isFriendly(other)) continue;
        if (this.isFFA() && other.troops() > this.player.troops() * 3) continue;
        return this.sendAttack(other);
      }
      return false;
    };

    const veryWeak = (): boolean => {
      const veryWeak = this.findVeryWeakEnemy(borderingEnemies);
      if (veryWeak) {
        return this.sendAttack(veryWeak);
      }
      return false;
    };

    const weakest = (): boolean => {
      if (borderingEnemies.length > 0) {
        // borderingEnemies is already sorted by troops (ascending), so first match is weakest
        const weakest = borderingEnemies[0];
        // In FFA, don't attack if they have more troops than us
        if (!this.isFFA() || weakest.troops() < this.player.troops()) {
          return this.sendAttack(weakest);
        }
      }
      return false;
    };

    const island = (): boolean => {
      if (borderingEnemies.length === 0) {
        const enemy = this.findNearestIslandEnemy();
        if (enemy) {
          return this.sendAttack(enemy);
        }
      }
      return false;
    };

    const donate = (): boolean => this.donateTroops();

    // Return strategies in order based on difficulty
    // Easy nations get the dumbest order, impossible nations get the smartest order
    switch (difficulty) {
      case Difficulty.Easy:
        // So dumb, they cant even find islanders
        // prettier-ignore
        return [nuked, bots, retaliate, assist, political, betray, hated, weakest];
      case Difficulty.Medium:
        // prettier-ignore
        return [bots, nuked, retaliate, assist, political, betray, hated, afk, traitor, weakest, island, donate];
      case Difficulty.Hard:
        // Strong veryWeak and juicy strats after the distracting hated strat, to make the nations weaker than impossible
        // prettier-ignore
        return [bots, retaliate, assist, political, betray, nuked, traitor, afk, hated, veryWeak, juicy, victim, weakest, island, donate];
      case Difficulty.Impossible:
        // prettier-ignore
        return [retaliate, bots, political, veryWeak, betray, assist, victim, traitor, juicy, afk, nuked, hated, weakest, island, donate];
      default:
        assertNever(difficulty);
    }
  }

  /**
   * Diplomacy+ V1.1: stable strategic personality derived from player id.
   * Most states respect diplomatic costs. A small minority are belligerent.
   */
  private diplomacyPersonality(): "cautious" | "pragmatic" | "opportunist" | "belligerent" {
    let h = 2166136261;
    for (const ch of this.player.id()) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    const roll = (h >>> 0) % 100;
    if (roll < 12) return "belligerent";
    if (roll < 32) return "opportunist";
    if (roll < 72) return "pragmatic";
    return "cautious";
  }

  private warWillingness(target: Player, hasCB: boolean): number {
    const personality = this.diplomacyPersonality();
    const strength = this.player.troops() / Math.max(1, target.troops());
    const relation = this.player.relation(target);

    let score = 0;
    score += Math.min(35, Math.max(-25, (strength - 1) * 25));
    if (relation === Relation.Hostile) score += 25;
    else if (relation === Relation.Distrustful) score += 10;

    // A legal justification helps, but is permission rather than an automatic attack order.
    if (hasCB) score += 18;

    // Diplomatic isolation makes another aggressive war less attractive.
    score -= this.player.threat() * 0.32;
    score -= Math.max(0, 70 - this.player.reputation()) * 0.38;

    if (personality === "cautious") score -= 20;
    if (personality === "pragmatic") score -= 5;
    if (personality === "opportunist") score += 8;
    if (personality === "belligerent") score += 32;

    // Common-threat pressure: attacking an already notorious aggressor is easier to justify strategically.
    if (target.threat() >= 55 || target.reputation() <= 45) score += 14;
    if (target.threat() >= 80 || target.reputation() <= 20) score += 14;

    return score;
  }

  private reviewTreatiesAndGuarantees() {
    // Piggyback on the diplomatic review cadence; deterministic enough for simulation,
    // sparse enough not to create treaty spam.
    if (this.game.ticks() % 600 > 20) return;
    const personality=this.diplomacyPersonality();
    const nearby=this.player.nearby().filter((p):p is Player=>p.isPlayer() && p!==this.player && p.type()!==PlayerType.Bot);

    // Cautious/pragmatic governments stabilize one acceptable frontier.
    if(personality==="cautious" || personality==="pragmatic"){
      const candidate=nearby.find((p)=>
        !this.player.isFriendly(p) &&
        this.player.nonAggressionPactWith(p)===null &&
        this.player.relation(p)!==Relation.Hostile &&
        p.threat()<45 && p.reputation()>50
      );
      if(candidate && this.random.chance(18)) this.player.setNonAggressionPact(candidate,3600);
    }

    // States sometimes guarantee a weaker nearby country when a notorious power is nearby.
    const dangerous=nearby.some((p)=>p.threat()>=65 || p.reputation()<=30);
    if(dangerous && personality!=="belligerent"){
      const weak=nearby
        .filter((p)=>!this.player.isFriendly(p) && !this.player.guarantees(p))
        .sort((a,b)=>a.troops()-b.troops())[0];
      if(weak && weak.troops()<this.player.troops()*0.75 && this.random.chance(15)){
        this.player.setGuarantee(weak,true);
        this.player.updateRelation(weak,6);
        weak.updateRelation(this.player,6);
      }
    }
  }

  /**
   * Diplomacy+ V1.0 diplomatic agenda: creates persistent objectives before war.
   */
  private reviewDiplomaticAgenda(): void {
    const now = this.game.ticks();
    if (now - this.lastDiplomaticReviewTick < 300) return;
    this.lastDiplomaticReviewTick = now;

    for (const other of this.game.players()) {
      if (other !== this.player && this.player.casusBelliAgainst(other) !== null) return;
    }

    const nearby = new Set(this.player.nearby().filter((p): p is Player => p.isPlayer()));

    // Detect borders that cut through one immutable historical region. This is
    // the physical basis for territorial tension: both governments literally
    // control tiles belonging to the same region. Build it from border tiles
    // once per diplomatic review instead of scanning the whole world per rival.
    const sharedRegionByNeighbor = new Map<PlayerID, number>();
    const neighborBuf: TileRef[] = [0, 0, 0, 0];
    for (const tile of this.player.borderTiles()) {
      const region = this.game.historicalRegionAt(tile);
      if (region === null) continue;
      const count = this.game.map().neighbors4(tile, neighborBuf);
      for (let i = 0; i < count; i++) {
        const other = this.game.owner(neighborBuf[i]);
        if (!other.isPlayer() || other === this.player) continue;
        if (this.game.historicalRegionAt(neighborBuf[i])?.id !== region.id) continue;
        sharedRegionByNeighbor.set(other.id(), region.id);
      }
    }

    let best: Player | null = null;
    let bestType: CasusBelliType | null = null;
    let bestScore = -Infinity;

    for (const other of this.game.players()) {
      if (other === this.player || other.type() === PlayerType.Bot || this.player.isFriendly(other)) continue;
      const relation = this.player.relation(other);
      const isNearby = nearby.has(other) || this.player.sharesBorderWith(other);
      const extreme = other.threat() >= 80 || other.reputation() <= 20;
      const containment = other.threat() >= 55 || other.reputation() <= 45;
      const sharedRegion = sharedRegionByNeighbor.get(other.id());

      // A split historical region is itself a standing source of tension. It
      // can generate a BorderClaim even before relations have collapsed.
      if (sharedRegion !== undefined) {
        const relationPressure = relation === Relation.Hostile ? 30 : relation === Relation.Distrustful ? 18 : 6;
        const score = 72 + relationPressure;
        if (score > bestScore) { best=other; bestType=CasusBelliType.BorderClaim; bestScore=score; }
        continue;
      }

      if (containment && (isNearby || extreme)) {
        const score = other.threat()*1.25 + (100-other.reputation()) + (isNearby?35:0) +
          (relation === Relation.Hostile ? 20 : 0);
        if (score > bestScore) { best=other; bestType=CasusBelliType.Containment; bestScore=score; }
        continue;
      }

      if (isNearby && (relation === Relation.Hostile || relation === Relation.Distrustful)) {
        const ratio=this.player.troops()/Math.max(1,other.troops());
        const score=45+(relation===Relation.Hostile?25:10)+Math.min(25,ratio*8);
        if(score>bestScore){best=other;bestType=CasusBelliType.BorderClaim;bestScore=score;}
      }
    }
    if(best!==null && bestType!==null) this.player.grantCasusBelli(best,bestType,6000);
  }

  /**
   * Diplomacy+ V0.6 strategic foreign-policy target.
   *
   * This deliberately looks at the whole diplomatic board. The old AI mostly
   * picked a military target first and only then asked whether it had a CB.
   * V0.6 reverses that for major threats: a dangerous state can become the
   * objective because of its political behaviour.
   */
  private findPoliticalTarget(): Player | null {
    let best: Player | null = null;
    let bestScore = 0;

    for (const other of this.game.players()) {
      if (other === this.player) continue;
      if (this.player.isFriendly(other)) continue;
      if (this.player.nonAggressionPactWith(other) !== null) continue;
      if (other.type() === PlayerType.Bot) continue;

      const cb = this.player.casusBelliAgainst(other);
      const hostile = this.player.relation(other) === Relation.Hostile;
      if (cb === null && !hostile) continue;

      // Political danger dominates the score. Relative military strength keeps
      // tiny states from suicidally challenging a superpower on every cycle,
      // while still allowing coalitions to form against a hegemon.
      const politicalDanger =
        other.threat() * 1.2 + (100 - other.reputation()) * 0.8;
      const cbBonus = cb !== null ? 35 : 0;
      const hostilityBonus = hostile ? 20 : 0;
      const strengthRatio =
        this.player.troops() / Math.max(1, other.troops());
      const feasibility = Math.min(25, strengthRatio * 15);
      const score = politicalDanger + cbBonus + hostilityBonus + feasibility;

      if (score > bestScore) {
        bestScore = score;
        best = other;
      }
    }

    // Below this level the normal military AI remains in charge.
    return bestScore >= 105 ? best : null;
  }

  private hasNeighboringBotWithStructures(): boolean {
    return this.player
      .nearby()
      .some(
        (n) =>
          n.isPlayer() &&
          n.type() === PlayerType.Bot &&
          !this.player.isFriendly(n) &&
          n.units().some((u) => Structures.has(u.type())),
      );
  }

  private hasReserveRatioTroops(): boolean {
    const maxTroops = this.game.config().maxTroops(this.player);
    const ratio = this.player.troops() / maxTroops;
    return ratio >= this.reserveRatio;
  }

  private hasTriggerRatioTroops(): boolean {
    const maxTroops = this.game.config().maxTroops(this.player);
    const ratio = this.player.troops() / maxTroops;
    return ratio >= this.triggerRatio;
  }

  findIncomingAttackPlayer(): Player | null {
    let incomingAttacks = this.player
      .incomingAttacks()
      .filter((attack) => !this.player.isFriendly(attack.attacker()));
    // Ignore bot attacks if we are not a bot.
    if (this.player.type() !== PlayerType.Bot) {
      incomingAttacks = incomingAttacks.filter(
        (attack) => attack.attacker().type() !== PlayerType.Bot,
      );
    }
    let largestAttack = 0;
    let largestAttacker: Player | undefined;
    for (const attack of incomingAttacks) {
      if (attack.troops() <= largestAttack) continue;
      largestAttack = attack.troops();
      largestAttacker = attack.attacker();
    }
    if (largestAttacker !== undefined) {
      return largestAttacker;
    }
    return null;
  }

  // Sort neighboring bots by density (troops / tiles) and attempt to attack many of them (Parallel attacks)
  // sendAttack will do nothing if we don't have enough reserve troops left
  // Bots that own structures are prioritized as targets (they might have stolen our structures and they will delete them!)
  private attackBots(): boolean {
    const bots = this.player
      .nearby()
      .filter(
        (n): n is Player =>
          n.isPlayer() &&
          this.player.isFriendly(n) === false &&
          n.type() === PlayerType.Bot,
      );

    if (bots.length === 0) {
      return false;
    }

    this.botAttackTroopsSent = 0;

    const density = (p: Player) => p.troops() / p.numTilesOwned();
    const ownsStructures = (p: Player) =>
      p.units().some((u) => Structures.has(u.type()));
    const sortedBots = bots.slice().sort((a, b) => {
      const aHasStructures = ownsStructures(a);
      const bHasStructures = ownsStructures(b);
      if (aHasStructures !== bHasStructures) {
        return aHasStructures ? -1 : 1;
      }
      return density(a) - density(b);
    });
    const reducedBots = sortedBots.slice(0, this.getBotAttackMaxParallelism());

    for (const bot of reducedBots) {
      this.sendAttack(bot);
    }

    // Only short-circuit the rest of the targeting pipeline if we actually
    // allocated some troops to bot attacks.
    return this.botAttackTroopsSent > 0;
  }

  private getBotAttackMaxParallelism(): number {
    const { difficulty } = this.game.config().gameConfig();
    switch (difficulty) {
      case Difficulty.Easy:
        return 1;
      case Difficulty.Medium:
        return this.random.chance(2) ? 1 : 2;
      case Difficulty.Hard:
        return 3;
      // On impossible difficulty, attack as much bots as possible in parallel
      case Difficulty.Impossible: {
        return 100;
      }
      default:
        assertNever(difficulty);
    }
  }

  private assistAllies(): boolean {
    if (this.emojiBehavior === undefined) throw new Error("not initialized");

    if (this.game.config().disableAlliances()) return false;

    for (const ally of this.player.allies()) {
      if (ally.targets().length === 0) continue;
      if (this.player.relation(ally) < Relation.Friendly) {
        this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_RELATION_TOO_LOW);
        continue;
      }
      for (const target of ally.targets()) {
        if (target === this.player) {
          this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_TARGET_ME);
          continue;
        }
        if (this.player.isFriendly(target)) {
          this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_TARGET_ALLY);
          continue;
        }
        if (!this.sendAttack(target)) continue;
        this.player.updateRelation(ally, -20);
        this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_ACCEPT);
        return true;
      }
    }
    return false;
  }

  // Find a traitor who isn't significantly stronger than us
  private findTraitor(borderingEnemies: Player[]): Player | null {
    if (this.game.config().disableAlliances()) return null;

    // borderingEnemies is already sorted by troops (ascending), so first match is weakest traitor
    return (
      borderingEnemies.find(
        (enemy) =>
          enemy.isTraitor() &&
          (!this.isFFA() || enemy.troops() < this.player.troops() * 1.2),
      ) ?? null
    );
  }

  private maybeBetrayAndAttack(
    borderingFriends: Player[],
    borderingEnemies: Player[],
  ): boolean {
    if (this.allianceBehavior === undefined) throw new Error("not initialized");

    if (this.game.config().disableAlliances()) return false;

    if (borderingFriends.length > 0) {
      // Computed once here, not per friend below - it doesn't depend on which one.
      const juiciestAlly =
        this.allianceBehavior.findJuiciestAlly(borderingFriends);
      for (const friend of borderingFriends) {
        if (
          this.allianceBehavior.maybeBetray(
            friend,
            juiciestAlly,
            borderingFriends,
            borderingEnemies,
          )
        ) {
          return this.sendAttack(friend, true);
        }
      }
    }
    return false;
  }

  private isBorderingNukedTerritory(): boolean {
    if (this.game.config().isUnitDisabled(UnitType.MissileSilo)) {
      return false;
    }

    // Boolean result, so neighbor order doesn't matter; a reused scratch
    // buffer keeps this allocation-free and allows early exit.
    const nbuf = NEIGHBOR_SCRATCH;
    for (const tile of this.player.borderTiles()) {
      const n = this.game.neighbors4(tile, nbuf);
      for (let i = 0; i < n; i++) {
        const neighbor = nbuf[i];
        if (
          this.game.isLand(neighbor) &&
          !this.game.hasOwner(neighbor) &&
          this.game.hasFallout(neighbor)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  // Find someone who isn't significantly stronger than us and is under big attack from others (50%+ of their troops incoming)
  private findVictim(borderingEnemies: Player[]): Player | null {
    // borderingEnemies is already sorted by troops (ascending), so first match is weakest victim
    return (
      borderingEnemies.find((enemy) => {
        if (this.isFFA() && enemy.troops() > this.player.troops() * 1.2) {
          return false;
        }

        const totalIncomingTroops = enemy
          .incomingAttacks()
          .reduce((sum, attack) => sum + attack.troops(), 0);

        return totalIncomingTroops > enemy.troops() * 0.5;
      }) ?? null
    );
  }

  // Find very weak (less than 15% of their maxTroops) enemies
  // which also don't have significantly more troops than us (to target MIRVed players)
  private findVeryWeakEnemy(borderingEnemies: Player[]): Player | null {
    const veryWeakEnemies = borderingEnemies.filter((enemy) => {
      const enemyMaxTroops = this.game.config().maxTroops(enemy);
      return (
        enemy.troops() < enemyMaxTroops * 0.15 &&
        (!this.isFFA() || enemy.troops() < this.player.troops() * 1.2)
      );
    });

    // borderingEnemies is already sorted by troops (ascending), so first match is weakest very weak enemy
    return veryWeakEnemies.length > 0 ? veryWeakEnemies[0] : null;
  }

  // Juiciest bordering enemy (Hard & Impossible only) we could plausibly beat (troops <= 75% of ours)
  private findJuicyTarget(borderingEnemies: Player[]): Player | null {
    const candidates = borderingEnemies.filter(
      (enemy) => enemy.troops() <= this.player.troops() * 0.75,
    );
    return findJuiciestTarget(this.game, candidates);
  }

  private findNearestIslandEnemy(): Player | null {
    if (this.game.config().isUnitDisabled(UnitType.TransportShip)) {
      return null;
    }

    // Check if we've already sent out the maximum number of transport ships
    if (
      this.player.unitCount(UnitType.TransportShip) >=
      this.game.config().boatMaxNumber()
    ) {
      return null;
    }

    // Check if we have any shore tiles to launch from
    const hasShore = Array.from(this.player.borderTiles()).some((t) =>
      this.game.isShore(t),
    );
    if (!hasShore) return null;

    const filteredPlayers = this.game.players().filter((p) => {
      if (p === this.player) return false;
      if (this.player.isFriendly(p)) return false;
      // In FFA, don't spam boats into players with more troops
      return !this.isFFA() || p.troops() < this.player.troops();
    });

    if (filteredPlayers.length === 0) return null;

    const playerCenter = this.getPlayerCenter(this.player);

    const sortedPlayers = filteredPlayers
      .map((filteredPlayer) => {
        const filteredPlayerCenter = this.getPlayerCenter(filteredPlayer);

        const playerCenterTile = this.game.ref(playerCenter.x, playerCenter.y);
        const filteredPlayerCenterTile = this.game.ref(
          filteredPlayerCenter.x,
          filteredPlayerCenter.y,
        );

        const distance = this.game.manhattanDist(
          playerCenterTile,
          filteredPlayerCenterTile,
        );
        return { player: filteredPlayer, distance };
      })
      .sort((a, b) => a.distance - b.distance); // Sort by distance (ascending)

    // Try players in order of distance until we find reachable candidates
    const reachablePlayers: Player[] = [];
    for (const entry of sortedPlayers) {
      const closest = closestTwoTiles(
        this.game,
        this.shoreTiles(this.player),
        this.shoreTiles(entry.player),
      );
      if (closest === null) continue;

      if (canBuildTransportShip(this.game, this.player, closest.y)) {
        reachablePlayers.push(entry.player);
        // We only need up to 2 reachable candidates
        if (reachablePlayers.length >= 2) break;
      }
    }

    if (reachablePlayers.length === 0) return null;

    // 33% chance to pick the second-nearest player if available
    if (reachablePlayers.length >= 2 && this.random.chance(3)) {
      return reachablePlayers[1];
    }

    return reachablePlayers[0];
  }

  // In team games, nations should be willing to attack/boat into stronger
  // enemies - they can rely on teammates to donate. In FFA, going after
  // someone significantly stronger is usually a losing proposition.
  private isFFA(): boolean {
    return this.game.config().gameConfig().gameMode === GameMode.FFA;
  }

  private getPlayerCenter(player: Player) {
    if (player.largestClusterBoundingBox) {
      return boundingBoxCenter(player.largestClusterBoundingBox);
    }
    return calculateBoundingBoxCenter(this.game, player.borderTiles());
  }

  attackRandomTarget() {
    // Save up troops until we reach the trigger ratio
    if (!this.hasTriggerRatioTroops()) return;

    // Retaliate against incoming attacks
    const incomingAttackPlayer = this.findIncomingAttackPlayer();
    if (incomingAttackPlayer) {
      if (this.sendAttack(incomingAttackPlayer, true)) return;
    }

    // Select a traitor as an enemy
    const toAttack = this.getNeighborTraitorToAttack();
    if (toAttack !== null) {
      if (this.random.chance(3)) {
        if (this.sendAttack(toAttack)) return;
      }
    }

    // Diplomacy+ V1.11: a charge ending is not a war ending. If this state
    // already has an authorized regional war whose target still owns tiles in
    // the selected region, prioritize another charge against that same target.
    // This turns one war into as many offensives as needed to reach the
    // historical regional border.
    for (const candidate of this.player.nearby()) {
      if (!candidate.isPlayer() || this.player.isFriendly(candidate)) continue;
      const goal = this.player.warGoalAgainst(candidate);
      if (goal !== CasusBelliType.BorderClaim && goal !== CasusBelliType.Containment) continue;
      const regionID = this.player.warGoalRegionAgainst(candidate);
      if (regionID === null) continue;
      const stillContested = this.game.historicalRegionOwnedTiles(regionID, candidate) > 0;
      if (!stillContested) {
        this.player.clearWarGoalRegionAgainst(candidate);
        continue;
      }
      if (this.player.sharesBorderWith(candidate) && this.sendAttack(candidate, true)) return;
    }

    // Choose a new enemy randomly
    const neighbors = this.player.nearby();
    for (const neighbor of this.random.shuffleArray(neighbors)) {
      if (!neighbor.isPlayer()) continue;
      if (this.player.isFriendly(neighbor)) continue;
      if (
        neighbor.type() === PlayerType.Nation ||
        neighbor.type() === PlayerType.Human
      ) {
        if (this.random.chance(2)) {
          continue;
        }
      }
      if (this.sendAttack(neighbor)) return;
    }
  }

  getNeighborTraitorToAttack(): Player | null {
    if (this.game.config().disableAlliances()) return null;

    const traitors = this.player
      .nearby()
      .filter(
        (n): n is Player =>
          n.isPlayer() && this.player.isFriendly(n) === false && n.isTraitor(),
      );
    return traitors.length > 0 ? this.random.randElement(traitors) : null;
  }

  forceSendAttack(target: Player | TerraNullius) {
    this.game.addExecution(
      new AttackExecution(
        this.player.troops() / 2,
        this.player,
        target.isPlayer() ? target.id() : this.game.terraNullius().id(),
        null,
        true,
        target.isPlayer() ? this.chooseLandAttackRegion(target) : null,
      ),
    );
  }

  sendAttack(target: Player | TerraNullius, force = false): boolean {
    if (!force && !this.shouldAttack(target)) return false;

    if (target.isPlayer() && target.type() !== PlayerType.Bot && !force) {
      const nap=this.player.nonAggressionPactWith(target);
      if(nap!==null && !this.player.isWarAuthorizedAgainst(target)){
        if(this.diplomacyPersonality()!=="belligerent" || !this.random.chance(30)) return false;
      }
      const authorized=this.player.isWarAuthorizedAgainst(target);
      const cb=this.player.casusBelliAgainst(target);
      if(!authorized && cb!==null && this.game.ticks()-cb.createdAt<180) return false;

      if(!authorized){
        const personality=this.diplomacyPersonality();
        let willingness=this.warWillingness(target,cb!==null);

        // Diplomacy+ V1.2: overseas annexation must be exceptional.
        // A containment CB against a remote country is permission to intervene,
        // not a reason to sail across the world and annex it.
        const overseas=!this.player.sharesBorderWith(target);
        if(overseas){
          willingness-=28;
          if(cb?.type===CasusBelliType.Containment) willingness-=18;
          if(personality==="cautious") willingness-=18;
          else if(personality==="pragmatic") willingness-=10;
        }

        // Diplomacy+ V1.10: sovereign wars are deliberately rarer. A CB is still
        // permission, not an instruction to attack; states now need a substantially
        // stronger strategic case before opening another interstate war.
        // Normal governments need a positive strategic case even when they possess a CB.
        // Belligerents are the exception: they can gamble on unjustified expansion.
        if(cb!==null){
          const threshold=personality==="belligerent"?5:personality==="opportunist"?22:35;
          if(willingness<threshold) return false;
        }else{
          if(personality!=="belligerent"){
            // Rare opportunistic breach by non-belligerents, and only when the strategic case is excellent.
            if(willingness<55 || !this.random.chance(30)) return false;
          }else{
            if(willingness<10 || !this.random.chance(5)) return false;
          }
        }
      }
    }

    if (target.isPlayer()) {
      if (this.player.sharesBorderWith(target)) {
        return this.sendLandAttack(target);
      } else {
        return this.sendBoatAttack(target);
      }
    } else {
      // sharesBorderWith(TerraNullius) counts water tiles as TN (ownerID 0 = TN smallID),
      // so use a land-only adjacency check to decide land vs boat attack.
      if (this.hasLandBorderWithTerraNullius()) {
        return this.sendLandAttack(target);
      } else {
        return this.sendBoatAttackToNearbyTerraNullius();
      }
    }
  }


  // Diplomacy+ V1.14: choose the region before creating the offensive.
  // Existing territorial wars keep their declared objective. For a new war,
  // choose among enemy regions that actually touch our land border, weighted
  // by the amount of frontier contact. This prevents the first combat tile
  // from randomly deciding the political objective.
  private chooseLandAttackRegion(target: Player): number | null {
    const existing = this.player.warGoalRegionAgainst(target);
    if (existing !== null) return existing;

    const map = this.game.map();
    const counts = new Map<number, number>();
    const nbuf = this.nbuf;
    for (const border of this.player.borderTiles()) {
      const n = map.neighbors4(border, nbuf);
      for (let i = 0; i < n; i++) {
        const tile = nbuf[i];
        if (map.ownerID(tile) !== target.smallID()) continue;
        const region = this.game.historicalRegionAt(tile);
        if (region === null) continue;
        counts.set(region.id, (counts.get(region.id) ?? 0) + 1);
      }
    }
    if (counts.size === 0) return null;
    let best: number[] = [];
    let bestCount = -1;
    for (const [regionID, count] of counts) {
      if (count > bestCount) { bestCount = count; best = [regionID]; }
      else if (count === bestCount) best.push(regionID);
    }
    return best.length === 1 ? best[0] : this.random.randElement(best);
  }

  private hasLandBorderWithTerraNullius(): boolean {
    // Allocation-free (neighbors() built an array per border tile and this
    // runs on every terra-nullius attack decision of every nation) — but
    // through for...of, not forEach: the dominant caller path answers true,
    // and the early exit matters more than the generator's overhead.
    const map = this.game.map();
    const nbuf = this.nbuf;
    for (const border of this.player.borderTiles()) {
      const n = map.neighbors4(border, nbuf);
      for (let i = 0; i < n; i++) {
        const neighbor = nbuf[i];
        if (
          map.isLand(neighbor) &&
          !map.isImpassable(neighbor) &&
          !map.hasOwner(neighbor)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private readonly nbuf: TileRef[] = [0, 0, 0, 0];

  /** The player's shore border tiles, in border-set order (one pass, no copy of the whole set). */
  private shoreTiles(player: Player): TileRef[] {
    const game = this.game;
    const out: TileRef[] = [];
    player.borderTiles().forEach((t) => {
      if (game.isShore(t)) out.push(t);
    });
    return out;
  }

  // Scans shore border tiles (every 10th) for unowned land within 5 water tiles
  // in each cardinal direction, then sends a transport ship to the first match.
  private sendBoatAttackToNearbyTerraNullius(): boolean {
    if (this.game.config().isUnitDisabled(UnitType.TransportShip)) return false;
    if (
      this.player.unitCount(UnitType.TransportShip) >=
      this.game.config().boatMaxNumber()
    )
      return false;

    const directions: [number, number][] = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ];
    const shores = this.shoreTiles(this.player);

    for (let i = 0; i < shores.length; i += 10) {
      const border = shores[i];

      const bx = this.game.x(border);
      const by = this.game.y(border);

      for (const [dx, dy] of directions) {
        const x1 = bx + dx;
        const y1 = by + dy;
        if (!this.game.isValidCoord(x1, y1)) continue;
        if (!this.game.isWater(this.game.ref(x1, y1))) continue;

        const nx = bx + dx * 5;
        const ny = by + dy * 5;
        if (!this.game.isValidCoord(nx, ny)) continue;
        const tile = this.game.ref(nx, ny);
        if (!this.game.isLand(tile)) continue;
        if (this.game.isImpassable(tile)) continue;
        if (this.game.hasOwner(tile)) continue;
        if (this.game.hasFallout(tile)) continue;
        if (!canBuildTransportShip(this.game, this.player, tile)) continue;

        const troops = Math.min(
          this.player.troops() / 5,
          this.troopSendCapForExpansion(),
        );
        if (troops < 1) return false;

        this.game.addExecution(
          new TransportShipExecution(this.player, tile, troops),
        );
        return true;
      }
    }
    return false;
  }

  shouldAttack(other: Player | TerraNullius): boolean {
    if (
      // Always attack Terra Nullius, non-humans and traitors
      other.isPlayer() === false ||
      other.type() !== PlayerType.Human ||
      other.isTraitor() ||
      // Always attack if we are a bot or in an HvN game
      this.player.type() === PlayerType.Bot ||
      this.game.config().gameConfig().playerTeams === HumansVsNations
    ) {
      return true;
    }

    // Prevent attacking of humans on lower difficulties
    const { difficulty } = this.game.config().gameConfig();
    if (difficulty === Difficulty.Easy && this.random.nextInt(0, 4) !== 0) {
      return false;
    }
    if (difficulty === Difficulty.Medium && this.random.chance(4)) {
      return false;
    }
    return true;
  }

  /**
   * For Hard & Impossible nations in FFA: returns true if `troops` is less
   * than 20% of the target's troop count, meaning the attack is too weak to
   * be worthwhile.  Bots and team games are exempt.
   */
  private isAttackTooWeak(troops: number, target: Player): boolean {
    if (this.player.type() === PlayerType.Bot) return false;
    if (this.game.config().gameConfig().gameMode === GameMode.Team)
      return false;
    // Nations under attack may retaliate freely
    if (this.player.incomingAttacks().length > 0) return false;
    const { difficulty } = this.game.config().gameConfig();
    return (
      (difficulty === Difficulty.Hard ||
        difficulty === Difficulty.Impossible) &&
      troops < target.troops() * 0.2
    );
  }

  /**
   * For Hard & Impossible nations in FFA: computes the max troops this nation
   * can send in an attack without letting its troop count drop below a
   * fraction of its strongest non-allied neighbor's troop count (Hard: 75%,
   * Impossible: 90%). Allied players and bot neighbors are not considered
   * threats. Bots and team games are entirely exempt. Returns Infinity when
   * no cap applies.
   *
   * Nations under attack may retaliate with at least the total incoming
   * attack troops, even if that exceeds the neighbor-based cap.
   */
  private troopSendCap(): number {
    if (this.player.type() === PlayerType.Bot) return Infinity;
    if (this.game.config().gameConfig().gameMode === GameMode.Team)
      return Infinity;

    const { difficulty } = this.game.config().gameConfig();
    let retainFraction: number;
    switch (difficulty) {
      case Difficulty.Hard:
        retainFraction = 0.75;
        break;
      case Difficulty.Impossible:
        retainFraction = 0.9;
        break;
      default:
        return Infinity;
    }

    let maxNeighborTroops = 0;
    for (const n of this.player.nearby()) {
      if (
        n.isPlayer() &&
        !this.player.isFriendly(n) &&
        n.type() !== PlayerType.Bot &&
        n.troops() > maxNeighborTroops
      ) {
        maxNeighborTroops = n.troops();
      }
    }

    let cap: number;
    if (maxNeighborTroops === 0) {
      cap = Infinity;
    } else {
      const minRetained = Math.ceil(maxNeighborTroops * retainFraction);
      cap = Math.max(0, this.player.troops() - minRetained);
    }

    // Nations under attack may retaliate with at least the incoming troops
    const incoming = this.player.incomingAttacks();
    if (incoming.length > 0) {
      const totalIncoming = incoming.reduce((sum, a) => sum + a.troops(), 0);
      cap = Math.max(cap, totalIncoming);
    }

    return cap;
  }

  // Like troopSendCap(), but floored above 0 — TerraNullius can't fight back, so it's throttled, not frozen.
  private troopSendCapForExpansion(): number {
    const cap = this.troopSendCap();
    if (cap > 0) return cap;
    return Math.ceil(this.player.troops() * 0.05);
  }

  private calculateAttackTroops(
    target: Player | TerraNullius,
    nonBotTroops: (targetTroops: number) => number,
  ): number | null {
    const maxTroops = this.game.config().maxTroops(this.player);
    const botWithStructures =
      target.isPlayer() &&
      target.type() === PlayerType.Bot &&
      target.units().some((u) => Structures.has(u.type()));
    // Use the expand ratio when attacking a bot that owns structures — we need to
    // recapture those structures ASAP, even before reaching the normal reserve.
    const useReserve = target.isPlayer() && !botWithStructures;
    const reserveRatio = useReserve ? this.reserveRatio : this.expandRatio;
    const targetTroops = maxTroops * reserveRatio;

    let troops;
    const isBotAttack =
      target.isPlayer() &&
      target.type() === PlayerType.Bot &&
      this.player.type() !== PlayerType.Bot;
    if (isBotAttack) {
      troops = this.calculateBotAttackTroops(
        target,
        this.player.troops() - targetTroops - this.botAttackTroopsSent,
      );
    } else {
      troops = nonBotTroops(targetTroops);
    }

    // Hard & Impossible: don't drop below neighbor troop threshold (also applies to TerraNullius/fallout).
    troops = Math.min(
      troops,
      target.isPlayer() ? this.troopSendCap() : this.troopSendCapForExpansion(),
    );

    if (troops < 1) {
      return null;
    }

    // Hard & Impossible: don't attack if we'd send less than 20% of target's troops
    if (target.isPlayer() && this.isAttackTooWeak(troops, target)) {
      return null;
    }

    if (target.isPlayer() && this.player.type() === PlayerType.Nation) {
      if (this.emojiBehavior === undefined) throw new Error("not initialized");
      this.emojiBehavior.maybeSendAttackEmoji(target);
    }

    // Only count troops that will actually be sent, post-cap.
    if (isBotAttack) {
      this.botAttackTroopsSent += troops;
    }

    return troops;
  }

  private sendLandAttack(target: Player | TerraNullius): boolean {
    const troops = this.calculateAttackTroops(
      target,
      (targetTroops) => this.player.troops() - targetTroops,
    );
    if (troops === null) {
      return false;
    }

    const targetRegionID = target.isPlayer()
      ? this.chooseLandAttackRegion(target)
      : null;

    this.game.addExecution(
      new AttackExecution(
        troops,
        this.player,
        target.isPlayer() ? target.id() : this.game.terraNullius().id(),
        null,
        true,
        targetRegionID,
      ),
    );
    return true;
  }

  private sendBoatAttack(target: Player): boolean {
    if (this.game.config().isUnitDisabled(UnitType.TransportShip)) {
      return false;
    }

    const closest = closestTwoTiles(
      this.game,
      this.shoreTiles(this.player),
      this.shoreTiles(target),
    );
    if (closest === null) {
      return false;
    }

    if (!canBuildTransportShip(this.game, this.player, closest.y)) {
      return false;
    }

    const troops = this.calculateAttackTroops(
      target,
      () => this.player.troops() / 5,
    );
    if (troops === null) {
      return false;
    }

    this.game.addExecution(
      new TransportShipExecution(this.player, closest.y, troops),
    );
    return true;
  }

  private calculateBotAttackTroops(target: Player, maxTroops: number): number {
    const { difficulty } = this.game.config().gameConfig();
    if (difficulty === Difficulty.Easy) {
      return maxTroops;
    }
    let troops = target.troops() * 4;

    // Don't send more troops than maxTroops (Keep reserve)
    if (troops > maxTroops) {
      // If we haven't enough troops left to do a big enough bot attack, skip it
      if (maxTroops < target.troops() * 2) {
        troops = 0;
      } else {
        troops = maxTroops;
      }
    }
    return troops;
  }

  private donateTroops(): boolean {
    // Only donate in team games
    if (this.game.config().gameConfig().gameMode !== GameMode.Team) {
      return false;
    }

    // Don't donate in public games (To balance HvN)
    if (this.game.config().gameConfig().gameType === GameType.Public) {
      return false;
    }

    // Check if donating troops is allowed
    if (this.game.config().donateTroops() === false) {
      return false;
    }

    // Don't donate if the game has a winner
    if (this.game.getWinner() !== null) {
      return false;
    }

    // Skip donating based on difficulty
    const { difficulty } = this.game.config().gameConfig();
    switch (difficulty) {
      case Difficulty.Easy:
        // Easy nations don't donate
        return false;
      case Difficulty.Medium:
        // Medium nations donate 25% of the time
        if (!this.random.chance(4)) {
          return false;
        }
        break;
      case Difficulty.Hard:
        // Hard nations donate 50% of the time
        if (!this.random.chance(2)) {
          return false;
        }
        break;
      case Difficulty.Impossible:
        // Impossible nations always try to donate
        break;
      default:
        assertNever(difficulty);
    }

    // Find teammates who are currently in combat
    const teammates = this.game
      .players()
      .filter((p) => this.player.isOnSameTeam(p))
      .filter(
        (p) => p.incomingAttacks().length > 0 || p.outgoingAttacks().length > 0,
      );

    if (teammates.length === 0) {
      return false;
    }

    // Find teammate with lowest troop percentage (troops / maxTroops)
    const teammatesWithTroopPercentage = teammates
      .map((teammate) => {
        const maxTroops = this.game.config().maxTroops(teammate);
        const troopPercentage = teammate.troops() / Math.max(maxTroops, 1);
        return { teammate, troopPercentage };
      })
      .sort((a, b) => a.troopPercentage - b.troopPercentage);

    // Try to donate to teammates in order of lowest troop percentage
    let selectedTeammate: Player | null = null;
    for (const entry of teammatesWithTroopPercentage) {
      if (this.player.canDonateTroops(entry.teammate)) {
        selectedTeammate = entry.teammate;
        break;
      }
    }

    if (selectedTeammate === null) {
      return false;
    }

    // Donate a portion of our troops (keeping reserve)
    const maxTroops = this.game.config().maxTroops(this.player);
    const troopsToKeep = maxTroops * this.reserveRatio;
    const availableTroops = this.player.troops() - troopsToKeep;

    if (availableTroops < 1) {
      return false;
    }

    this.game.addExecution(
      new DonateTroopsExecution(
        this.player,
        selectedTeammate.id(),
        availableTroops,
      ),
    );

    return true;
  }
}
