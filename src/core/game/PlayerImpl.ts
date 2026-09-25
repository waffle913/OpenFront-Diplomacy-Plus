import { PseudoRandom } from "../PseudoRandom";
import { ClientID } from "../Schemas";
import {
  assertNever,
  findClosestBy,
  minInt,
  simpleHash,
  toInt,
  within,
} from "../Util";
import { AttackImpl } from "./AttackImpl";
import {
  Alliance,
  AllianceInfo,
  AllianceRequest,
  AllPlayers,
  Attack,
  BuildableUnit,
  CasusBelli,
  CasusBelliType,
  Cell,
  ColoredTeams,
  DiplomaticCrisis,
  DiplomaticMemory,
  DiplomaticMemoryOptions,
  DiplomaticMemoryType,
  DisconnectSnapshot,
  Embargo,
  EmojiMessage,
  GameMode,
  GameType,
  Gold,
  GovernmentProfile,
  GovernmentStyle,
  isDiplomacyPlusParticipant,
  MAX_UPGRADE_AMOUNT,
  MutableAlliance,
  NationalAgenda,
  NationalInterests,
  Player,
  PlayerBuildable,
  PlayerBuildableUnitType,
  PlayerID,
  PlayerInfo,
  PlayerProfile,
  PlayerType,
  Relation,
  StrategicResource,
  StrategicResources,
  Structures,
  TaxPolicy,
  Team,
  TerraNullius,
  Tick,
  TradeContract,
  Unit,
  UnitParams,
  UnitType,
} from "./Game";
import { GameImpl } from "./GameImpl";
import { andFN, manhattanDistFN, TileRef } from "./GameMap";
import {
  ATTACK_DELTA_INCOMING,
  ATTACK_DELTA_OUTGOING,
  diffPlayerUpdate,
  packAttackTroopDeltas,
} from "./GameUpdateUtils";
import {
  AllianceView,
  AttackUpdate,
  GameUpdateType,
  PlayerUpdate,
} from "./GameUpdates";
import { buildNationalAgenda } from "./NationalAgenda";
import { ReadonlyTileSet, TileSet } from "./TileSet";
import {
  bumpTraversalGeneration,
  tileTraversalScratch,
} from "./TileTraversalScratch";
import {
  bestShoreDeploymentSource,
  canBuildTransportShip,
} from "./TransportShipUtils";
import { UnitImpl } from "./UnitImpl";

// Rot re-stamps every second, so a little slack keeps the cue from strobing.
const DECAY_CUE_GRACE_TICKS = 30;

interface Target {
  tick: Tick;
  target: Player;
}

class Donation {
  constructor(
    public readonly recipient: Player,
    public readonly tick: Tick,
  ) {}
}

// Shared singletons for empty collections in toFullUpdate. Sharing
// references lets diffPlayerUpdate's `a === b` fast paths skip structural
// comparison and avoids per-player-per-tick allocations. The arrays are
// frozen so accidental in-worker mutation throws instead of silently
// corrupting every player's updates; updates crossing to the main thread
// are structured-cloned (clones are mutable). Sets cannot be frozen
// (Set.add ignores freeze) — EMPTY_EMBARGOES must never be mutated.
const EMPTY_NUMBER_ARRAY: number[] = [];
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_ATTACK_UPDATES: AttackUpdate[] = [];
const EMPTY_ALLIANCE_VIEWS: AllianceView[] = [];
const EMPTY_EMOJIS: EmojiMessage[] = [];
const EMPTY_EMBARGOES = new Set<string>();
const EMPTY_NATIONAL_AGENDA: NationalAgenda = {
  generatedAt: 0,
  reevaluateAt: 0,
  goals: [],
  concerns: [],
  strategicRegions: [],
  rivals: [],
  preferredPartners: [],
};

function diplomaticMemoryPolicy(type: DiplomaticMemoryType): {
  durationTicks: number;
  severity: number;
  aggregates: boolean;
} {
  switch (type) {
    case "trade_started":
    case "trade_completed":
    case "trade_failed":
    case "economic_aid":
    case "joint_project":
      return { durationTicks: 1800, severity: 20, aggregates: false };
    case "nap_signed":
    case "guarantee_given":
    case "guarantee_withdrawn":
    case "peace_signed":
    case "crisis_complied":
    case "mediation_accepted":
    case "territory_returned":
      return { durationTicks: 3600, severity: 35, aggregates: false };
    case "nap_broken":
    case "crisis_refused":
    case "trade_ship_seized":
    case "trade_ship_destroyed":
    case "reparations_requested":
    case "reparations_refused":
    case "mediation_refused":
    case "sanctions_imposed":
      return { durationTicks: 7200, severity: 60, aggregates: true };
    case "war_started":
    case "territory_lost":
    case "truce_broken":
    case "unjustified_war":
    case "international_condemnation":
    case "resolution_ignored":
      return { durationTicks: 12000, severity: 85, aggregates: true };
    case "reparations_paid":
      return { durationTicks: 4800, severity: 45, aggregates: false };
  }
}
// Reusable buffers for hot loops. The simulation is single-threaded and these
// are fully consumed before any re-entrant call, so sharing is safe.
const NEIGHBOR_SCRATCH: TileRef[] = [0, 0, 0, 0];
const UNITS_SCRATCH: Unit[] = [];
const TYPE_SET_SCRATCH = new Set<UnitType>();
// N, S, W, E — the sampling directions used by shoreReachableNeighbors().
const SHORE_DIRECTIONS_DX = [0, 0, -1, 1];
const SHORE_DIRECTIONS_DY = [-1, 1, 0, 0];
Object.freeze(EMPTY_NUMBER_ARRAY);
Object.freeze(EMPTY_STRING_ARRAY);
Object.freeze(EMPTY_ATTACK_UPDATES);
Object.freeze(EMPTY_ALLIANCE_VIEWS);
Object.freeze(EMPTY_EMOJIS);

export class PlayerImpl implements Player {
  public _lastTileChange: number = 0;
  // Bumped on every ownership change of one of this player's tiles (several
  // can happen within one tick, so the tick alone is not a cache key).
  public _tileChangeVersion: number = 0;
  public _pseudo_random: PseudoRandom;

  private _gold: bigint;
  private _troops: bigint;
  // Diplomacy+ V1.16 strategic-resource stocks. Production is territorial and
  // computed by GameImpl; military consumption is intentionally deferred.
  private _food = 250;
  private _materials = 180;
  private _fuel = 90;
  private static readonly RESOURCE_CAP = 5000;
  private tradeContracts_ = new Map<string, TradeContract>();
  private lastEconomicAid = new Map<PlayerID, Tick>();
  private lastJointProject = new Map<PlayerID, Tick>();
  private diplomaticCrises_ = new Map<string, DiplomaticCrisis>();

  /** Cumulative ship-trade revenue (arrival credit for src + dst port owners). */
  private _tradeGold: bigint = 0n;
  /** Cumulative train revenue: own trains + others' trains stopping at own stations. */
  private _trainGold: bigint = 0n;
  /** Cumulative piracy revenue: payouts for captured trade ships. */
  private _piracyGold: bigint = 0n;
  /** Cumulative gold received from all sources (incremented in addGold). */
  private _goldEarned: bigint = 0n;

  markedTraitorTick = -1;
  markedDoomsdayClockTick = -1;
  /** Tick territory rot last took land from this player (-1 = never). */
  private rottedAtTick = -1;
  private _betrayalCount: number = 0;

  private embargoes = new Map<PlayerID, Embargo>();

  public _borderTiles = new TileSet();

  public _units: Unit[] = [];
  /** Bumped on every change that can alter a per-type answer over _units: add, remove, ownership
   *  transfer, level-up, construction toggle (see UnitImpl). Keys the three memos below. */
  public _myUnitsVersion = 0;
  private readonly myUnitsMemo = new Map<
    UnitType,
    { version: number; list: Unit[] }
  >();
  private readonly myUnitCountMemo = new Map<
    UnitType,
    { version: number; count: number }
  >();
  private readonly myUnitsOwnedMemo = new Map<
    UnitType,
    { version: number; owned: number }
  >();
  public _tiles = new TileSet();

  public pastOutgoingAllianceRequests: AllianceRequest[] = [];
  private _expiredAlliances: Alliance[] = [];

  private targets_: Target[] = [];

  private outgoingEmojis_: EmojiMessage[] = [];
  private outgoingQuickChats_ = new Map<number, Tick>();

  private sentDonations: Donation[] = [];

  private relations = new Map<Player, number>();
  private diplomaticTrust = new Map<PlayerID, number>();
  private diplomaticMemory: DiplomaticMemory[] = [];
  private lastMemoryPruneEpoch = -1;
  private casusBelli = new Map<PlayerID, CasusBelli>();
  private warAuthorizations = new Map<PlayerID, Tick>();
  // Diplomacy+ V1.3: why this war is being fought. Kept separate from the CB,
  // because the CB is consumed when hostilities begin.
  private warGoals = new Map<PlayerID, CasusBelliType>();
  // Diplomacy+ V1.11: persistent geographic objective for a regional war.
  // AttackExecution instances are only individual offensives; this survives
  // their retreat so later offensives continue toward the same region.
  private warGoalRegions = new Map<PlayerID, number>();
  // Diplomacy+ V1.15: defender control when a regional war goal is fixed.
  // This lets the UI expose objective progress / war score independently of individual charges.
  private warGoalInitialTargetTiles = new Map<PlayerID, number>();
  private nonAggressionPacts = new Map<PlayerID, Tick>();
  private tradeAgreements = new Map<PlayerID, Tick>();
  private postWarTruces = new Map<PlayerID, Tick>();
  private guarantees_ = new Set<PlayerID>();
  private _threat = 0;
  private _reputation = 100;
  private _stability = 70;
  private _publicSatisfaction = 65;
  private _taxPolicy: TaxPolicy = "normal";
  private _mobilizationTarget = 100;
  private cachedNationalInterests:
    | { epoch: number; value: NationalInterests }
    | undefined;
  private nationalAgenda_: NationalAgenda | undefined;
  private cachedDiplomaticRelations:
    | {
        epoch: number;
        value: NonNullable<PlayerUpdate["diplomaticRelations"]>;
      }
    | undefined;
  private cachedWarGoals:
    | { epoch: number; value: NonNullable<PlayerUpdate["warGoals"]> }
    | undefined;
  private _governmentStyle: GovernmentStyle;
  private _governmentGeneration = 1;
  private _governmentTermEndsAt: Tick;

  private lastDeleteUnitTick: Tick = -1;
  private lastEmbargoAllTick: Tick = -1;

  public _incomingAttacks: Attack[] = [];
  public _outgoingAttacks: Attack[] = [];
  public _outgoingLandAttacks: Attack[] = [];

  public _alliances: MutableAlliance[] = [];

  private _spawnTile: TileRef | undefined;
  private _isDisconnected = false;
  private _disconnectSnapshot: DisconnectSnapshot | null = null;

  /**
   * Last PlayerUpdate emitted for this player on the worker→main channel.
   * Used by GameImpl's tick loop to compute field-level diffs. Undefined on
   * first emission (full snapshot sent).
   */
  public lastSentUpdate: PlayerUpdate | undefined;

  constructor(
    private mg: GameImpl,
    private _smallID: number,
    private readonly playerInfo: PlayerInfo,
    startTroops: number,
    private readonly _team: Team | null,
  ) {
    this._troops = toInt(startTroops);
    this._gold = mg.config().startingGold(playerInfo);
    this._pseudo_random = new PseudoRandom(simpleHash(this.playerInfo.id));
    const styles: GovernmentStyle[] = [
      "hawkish",
      "pragmatic",
      "cooperative",
      "cautious",
    ];
    this._governmentStyle =
      styles[Math.abs(simpleHash(this.playerInfo.id)) % styles.length];
    this._governmentTermEndsAt =
      mg.ticks() + 3600 + (Math.abs(simpleHash(this.playerInfo.id)) % 1200);
  }

  largestClusterBoundingBox: { min: Cell; max: Cell } | null;

  /**
   * Build a PlayerUpdate for the worker→main wire.
   *
   * The first call for a player returns the full snapshot. Subsequent calls
   * return only fields that changed since the previous call (a partial
   * `{ type, id, ...changedFields }`), or `null` if nothing changed.
   *
   * tilesOwned / gold / troops / goldEarned are excluded from partial
   * updates (they churn for nearly every alive player every tick): when any
   * of them changed, a `[smallID, tilesOwned, gold, troops, goldEarned]`
   * quint is pushed to `statsOut` instead, which GameImpl drains into the
   * transferable `packedPlayerUpdates` buffer. Attack troop counts likewise
   * go to `attackTroopsOut` as `[smallID, direction, index, troops]` quads
   * (→ `packedAttackUpdates`) instead of re-sending whole attack arrays.
   *
   * `lastSentUpdate` is updated to the full snapshot on every call.
   */
  toUpdate(
    statsOut?: number[],
    attackTroopsOut?: number[],
  ): PlayerUpdate | null {
    const full = this.toFullUpdate();
    const prev = this.lastSentUpdate;
    this.lastSentUpdate = full;
    if (prev === undefined) return full;
    if (
      statsOut !== undefined &&
      (prev.tilesOwned !== full.tilesOwned ||
        prev.gold !== full.gold ||
        prev.troops !== full.troops ||
        prev.goldEarned !== full.goldEarned)
    ) {
      // goldEarned gets its own comparison: it can change even when gold
      // nets back to its previous value within one tick (addGold followed
      // by removeGold), and the quint must still flush then.
      statsOut.push(
        full.smallID!,
        full.tilesOwned!,
        Number(full.gold),
        full.troops!,
        Number(full.goldEarned),
      );
    }
    if (attackTroopsOut !== undefined) {
      packAttackTroopDeltas(
        prev.outgoingAttacks,
        full.outgoingAttacks,
        full.smallID!,
        ATTACK_DELTA_OUTGOING,
        attackTroopsOut,
      );
      packAttackTroopDeltas(
        prev.incomingAttacks,
        full.incomingAttacks,
        full.smallID!,
        ATTACK_DELTA_INCOMING,
        attackTroopsOut,
      );
    }
    return diffPlayerUpdate(prev, full);
  }

  private toFullUpdate(): PlayerUpdate {
    // Empty collections reuse shared singletons (EMPTY_*) so
    // diffPlayerUpdate's reference fast paths hit and nothing is allocated.
    // This runs for every player every tick; most collections are empty for
    // most players. The singletons are never mutated — updates are
    // structured-cloned before leaving the worker.
    let outgoingAllianceRequests = EMPTY_STRING_ARRAY;
    for (const ar of this.mg.allianceRequests) {
      if (ar.requestor() === this) {
        if (outgoingAllianceRequests === EMPTY_STRING_ARRAY) {
          outgoingAllianceRequests = [];
        }
        outgoingAllianceRequests.push(ar.recipient().id());
      }
    }

    const alliances = this.alliances();
    let allies = EMPTY_NUMBER_ARRAY;
    let allianceViews = EMPTY_ALLIANCE_VIEWS;
    if (alliances.length > 0) {
      allies = alliances.map((a) => a.other(this).smallID());
      const extensionCutoff =
        this.mg.ticks() + this.mg.config().allianceExtensionPromptOffset();
      allianceViews = alliances.map(
        (a) =>
          ({
            id: a.id(),
            other: a.other(this).id(),
            createdAt: a.createdAt(),
            expiresAt: a.expiresAt(),
            hasExtensionRequest: a.expiresAt() <= extensionCutoff,
          }) satisfies AllianceView,
      );
    }

    let embargoes = EMPTY_EMBARGOES;
    if (this.embargoes.size > 0) {
      embargoes = new Set<string>();
      for (const id of this.embargoes.keys()) {
        embargoes.add(id.toString());
      }
    }

    let targets = EMPTY_NUMBER_ARRAY;
    if (this.targets_.length > 0) {
      const t = this.targets();
      if (t.length > 0) {
        targets = t.map((p) => p.smallID());
      }
    }

    let outgoingEmojis = EMPTY_EMOJIS;
    if (this.outgoingEmojis_.length > 0) {
      const e = this.outgoingEmojis();
      if (e.length > 0) {
        outgoingEmojis = e;
      }
    }

    const outgoingAttacks =
      this._outgoingAttacks.length === 0
        ? EMPTY_ATTACK_UPDATES
        : this._outgoingAttacks.map((a) => {
            return {
              attackerID: a.attacker().smallID(),
              targetID: a.target().smallID(),
              troops: a.troops(),
              id: a.id(),
              retreating: a.retreating(),
            } satisfies AttackUpdate;
          });

    let incomingAttacks = EMPTY_ATTACK_UPDATES;
    if (this._incomingAttacks.length > 0) {
      const incoming = this.incomingAttacks();
      if (incoming.length > 0) {
        incomingAttacks = incoming.map((a) => {
          return {
            attackerID: a.attacker().smallID(),
            targetID: a.target().smallID(),
            troops: a.troops(),
            id: a.id(),
            retreating: a.retreating(),
          } satisfies AttackUpdate;
        });
      }
    }

    // OFM live standings: elimination info is stored on the player's stats
    // (set live in the sim via mg.stats()), surfaced here so it rides the live
    // PlayerUpdate every tick rather than only appearing in the game-end record.
    const deathStats = this.mg.stats().getPlayerStats(this);
    const diplomacyPlusEnabled = isDiplomacyPlusParticipant(this);
    const production = diplomacyPlusEnabled
      ? this.mg.resourceProduction(this)
      : undefined;
    const consumption = diplomacyPlusEnabled
      ? this.resourceConsumption()
      : undefined;
    const relationEpoch = Math.floor(this.mg.ticks() / 10);
    let diplomaticRelations = this.cachedDiplomaticRelations?.value;
    if (
      diplomacyPlusEnabled &&
      (diplomaticRelations === undefined ||
        this.cachedDiplomaticRelations?.epoch !== relationEpoch)
    ) {
      const relationPlayers = new Set<Player>();
      for (const other of this.relations.keys()) relationPlayers.add(other);
      for (const otherID of this.diplomaticTrust.keys()) {
        if (this.mg.hasPlayer(otherID))
          relationPlayers.add(this.mg.player(otherID));
      }
      for (const memory of this.diplomaticMemory) {
        if (this.mg.hasPlayer(memory.otherID))
          relationPlayers.add(this.mg.player(memory.otherID));
      }
      const borderingSmallIDs = new Set<number>();
      const map = this.mg.map();
      const nbuf: TileRef[] = [0, 0, 0, 0];
      for (const border of this._borderTiles) {
        const count = map.neighbors4(border, nbuf);
        for (let i = 0; i < count; i++) {
          const ownerID = map.ownerID(nbuf[i]);
          if (ownerID !== this.smallID()) borderingSmallIDs.add(ownerID);
        }
      }
      diplomaticRelations = Array.from(relationPlayers)
        .filter((other) => other.isAlive() && isDiplomacyPlusParticipant(other))
        .map((other) => ({
          otherID: other.id(),
          opinion: this.relationScore(other),
          trust: this.trust(other),
          perceivedThreat: this.perceivedThreat(
            other,
            borderingSmallIDs.has(other.smallID()),
          ),
        }))
        .sort((a, b) => a.otherID.localeCompare(b.otherID));
      this.cachedDiplomaticRelations = {
        epoch: relationEpoch,
        value: diplomaticRelations,
      };
    }

    const warGoalEpoch = Math.floor(this.mg.ticks() / 10);
    let warGoals = this.cachedWarGoals?.value;
    if (
      diplomacyPlusEnabled &&
      (warGoals === undefined || this.cachedWarGoals?.epoch !== warGoalEpoch)
    ) {
      warGoals = Array.from(this.warGoals, ([targetID, type]) => {
        const target = this.mg.hasPlayer(targetID)
          ? this.mg.player(targetID)
          : null;
        const regionID = this.warGoalRegions.get(targetID);
        const initialTargetTiles =
          this.warGoalInitialTargetTiles.get(targetID) ?? 0;
        let remainingTargetTiles = initialTargetTiles;
        if (target !== null && regionID !== undefined) {
          remainingTargetTiles = this.mg.historicalRegionOwnedTiles(
            regionID,
            target,
          );
        }
        const warScore =
          initialTargetTiles > 0
            ? Math.round(
                ((initialTargetTiles - remainingTargetTiles) /
                  initialTargetTiles) *
                  100,
              )
            : 0;
        return {
          targetID,
          type,
          regionID,
          initialTargetTiles,
          remainingTargetTiles,
          warScore,
        };
      }).filter((wg) => {
        const target = this.mg.hasPlayer(wg.targetID)
          ? this.mg.player(wg.targetID)
          : null;
        return target !== null && this.isWarAuthorizedAgainst(target);
      });
      this.cachedWarGoals = { epoch: warGoalEpoch, value: warGoals };
    }

    return {
      type: GameUpdateType.Player,
      clientID: this.clientID(),
      name: this.name(),
      displayName: this.displayName(),
      clanTag: this.clanTag(),
      nationFlag: this.nationFlag(),
      id: this.id(),
      team: this.team() ?? undefined,
      smallID: this.smallID(),
      playerType: this.type(),
      isAlive: this.isAlive(),
      isDisconnected: this.isDisconnected(),
      killedBy: deathStats?.killedBy ?? null,
      deathPosition: deathStats?.deathPosition ?? null,
      tilesOwned: this.numTilesOwned(),
      gold: this._gold,
      tradeGold: this._tradeGold,
      trainGold: this._trainGold,
      piracyGold: this._piracyGold,
      goldEarned: this._goldEarned,
      troops: this.troops(),
      food: diplomacyPlusEnabled ? this._food : undefined,
      materials: diplomacyPlusEnabled ? this._materials : undefined,
      fuel: diplomacyPlusEnabled ? this._fuel : undefined,
      foodProduction: production?.food,
      materialsProduction: production?.materials,
      fuelProduction: production?.fuel,
      foodConsumption: consumption?.food,
      materialsConsumption: consumption?.materials,
      fuelConsumption: consumption?.fuel,
      resourceShortages:
        production !== undefined && consumption !== undefined
          ? {
              food: this._food <= 0 && consumption.food > production.food,
              materials:
                this._materials <= 0 &&
                consumption.materials > production.materials,
              fuel: this._fuel <= 0 && consumption.fuel > production.fuel,
            }
          : undefined,
      allies: allies,
      embargoes: embargoes,
      isTraitor: this.isTraitor(),
      traitorRemainingTicks: this.getTraitorRemainingTicks(),
      inDoomsdayClock: this.inDoomsdayClock(),
      isDecaying: this.isDecaying(),
      markedDoomsdayClockTick: this.markedDoomsdayClockTick,
      targets: targets,
      outgoingEmojis: outgoingEmojis,
      outgoingAttacks: outgoingAttacks,
      incomingAttacks: incomingAttacks,
      outgoingAllianceRequests: outgoingAllianceRequests,
      alliances: allianceViews,
      hasSpawned: this.hasSpawned(),
      spawnTile: this._spawnTile,
      betrayals: this._betrayalCount,
      threat: this.threat(),
      reputation: this.reputation(),
      stability: diplomacyPlusEnabled ? this.stability() : undefined,
      publicSatisfaction: diplomacyPlusEnabled
        ? this.publicSatisfaction()
        : undefined,
      taxPolicy: diplomacyPlusEnabled ? this.taxPolicy() : undefined,
      mobilizationTarget: diplomacyPlusEnabled
        ? this.mobilizationTarget()
        : undefined,
      civilianManpowerPotential: diplomacyPlusEnabled
        ? this.mg.config().civilianManpowerPotential(this)
        : undefined,
      militaryCapacity: diplomacyPlusEnabled
        ? this.mg.config().maxTroops(this)
        : undefined,
      governmentProfile: diplomacyPlusEnabled
        ? this.governmentProfile()
        : undefined,
      nationalInterests: diplomacyPlusEnabled
        ? this.nationalInterests()
        : undefined,
      nationalAgenda: diplomacyPlusEnabled ? this.nationalAgenda() : undefined,
      diplomaticRelations: diplomacyPlusEnabled
        ? diplomaticRelations
        : undefined,
      diplomaticMemories: diplomacyPlusEnabled
        ? this.diplomaticMemories().map((memory) => ({ ...memory }))
        : undefined,
      tradeContracts: diplomacyPlusEnabled
        ? Array.from(this.tradeContracts_.values(), (contract) => ({
            ...contract,
          })).sort((a, b) => a.id.localeCompare(b.id))
        : undefined,
      diplomaticCrises: diplomacyPlusEnabled
        ? Array.from(this.diplomaticCrises_.values(), (crisis) => ({
            ...crisis,
          })).sort((a, b) => a.id.localeCompare(b.id))
        : undefined,
      casusBelli: diplomacyPlusEnabled
        ? Array.from(this.casusBelli.values())
            .filter((cb) => cb.expiresAt > this.mg.ticks())
            .map((cb) => ({ ...cb }))
        : undefined,
      warGoals: diplomacyPlusEnabled ? warGoals : undefined,
      nonAggressionPacts: diplomacyPlusEnabled
        ? Array.from(this.nonAggressionPacts, ([otherID, expiresAt]) => ({
            otherID,
            expiresAt,
          })).filter((x) => x.expiresAt > this.mg.ticks())
        : undefined,
      tradeAgreements: diplomacyPlusEnabled
        ? Array.from(this.tradeAgreements, ([otherID, expiresAt]) => ({
            otherID,
            expiresAt,
          })).filter((x) => x.expiresAt > this.mg.ticks())
        : undefined,
      truces: diplomacyPlusEnabled
        ? Array.from(this.postWarTruces, ([otherID, expiresAt]) => ({
            otherID,
            expiresAt,
          })).filter((x) => x.expiresAt > this.mg.ticks())
        : undefined,
      guarantees: diplomacyPlusEnabled
        ? Array.from(this.guarantees_)
        : undefined,
      lastDeleteUnitTick: this.lastDeleteUnitTick,
      isLobbyCreator: this.isLobbyCreator(),
    };
  }

  smallID(): number {
    return this._smallID;
  }

  name(): string {
    return this.playerInfo.name;
  }
  displayName(): string {
    return this.playerInfo.displayName;
  }
  clanTag(): string | null {
    return this.playerInfo.clanTag;
  }
  nationFlag(): string | null {
    return this.playerInfo.nationFlag;
  }
  clientID(): ClientID | null {
    return this.playerInfo.clientID;
  }

  id(): PlayerID {
    return this.playerInfo.id;
  }

  type(): PlayerType {
    return this.playerInfo.playerType;
  }

  units(): Unit[];
  units(types: readonly UnitType[]): Unit[];
  units(type: UnitType, type2?: UnitType, type3?: UnitType): Unit[];
  units(
    first?: UnitType | readonly UnitType[],
    second?: UnitType,
    third?: UnitType,
  ): Unit[] {
    if (first === undefined) {
      return this._units;
    }

    // Hot path. Matches are gathered into a reusable scratch buffer and
    // copied out with an exact-size slice, so each call allocates exactly
    // one right-sized result array. Fixed-arity parameters (rather than a
    // rest parameter) avoid allocating an argument array per call.
    const scratch = UNITS_SCRATCH;
    let n = 0;

    if (Array.isArray(first)) {
      const types = first as readonly UnitType[];
      if (types.length === 0) {
        return this._units;
      }
      const ts = TYPE_SET_SCRATCH;
      ts.clear();
      for (const t of types) {
        ts.add(t);
      }
      for (const u of this._units) {
        if (ts.has(u.type())) scratch[n++] = u;
      }
    } else if (second === undefined) {
      // Single-type queries repeat heavily (warship heal, nation ship tracking,
      // troop caps): memoised on the per-player units version; hits hand out a copy.
      const memo = this.myUnitsMemo.get(first as UnitType);
      if (memo !== undefined && memo.version === this._myUnitsVersion) {
        return memo.list.slice();
      }
      for (const u of this._units) {
        if (u.type() === first) scratch[n++] = u;
      }
      const list = scratch.slice(0, n);
      this.myUnitsMemo.set(first as UnitType, {
        version: this._myUnitsVersion,
        list,
      });
      return list.slice();
    } else if (third === undefined) {
      for (const u of this._units) {
        const t = u.type();
        if (t === first || t === second) scratch[n++] = u;
      }
    } else {
      for (const u of this._units) {
        const t = u.type();
        if (t === first || t === second || t === third) scratch[n++] = u;
      }
    }
    return scratch.slice(0, n);
  }

  private numUnitsConstructed: Partial<Record<UnitType, number>> = {};
  private recordUnitConstructed(type: UnitType): void {
    if (this.numUnitsConstructed[type] !== undefined) {
      this.numUnitsConstructed[type]++;
    } else {
      this.numUnitsConstructed[type] = 1;
    }
  }

  // Count of units built by the player, including those still under
  // construction. recordUnitConstructed() is called in buildUnit() the moment a
  // unit is created (while still under construction), so numUnitsConstructed
  // already accounts for in-progress builds — don't re-count them.
  unitsConstructed(type: UnitType): number {
    return this.numUnitsConstructed[type] ?? 0;
  }

  // Count of units owned by the player, not including construction
  unitCount(type: UnitType): number {
    // Every train station asked for the owner's factory count every tick — a walk
    // over the whole unit list per station (~2 % of a long headless game).
    const memo = this.myUnitCountMemo.get(type);
    if (memo !== undefined && memo.version === this._myUnitsVersion) {
      return memo.count;
    }
    let total = 0;
    for (const unit of this._units) {
      if (unit.type() === type) {
        total += unit.level();
      }
    }
    this.myUnitCountMemo.set(type, {
      version: this._myUnitsVersion,
      count: total,
    });
    return total;
  }

  // Count of units owned by the player, including construction
  unitsOwned(type: UnitType): number {
    const memo = this.myUnitsOwnedMemo.get(type);
    if (memo !== undefined && memo.version === this._myUnitsVersion) {
      return memo.owned;
    }
    let total = 0;
    for (const unit of this._units) {
      if (unit.type() === type) {
        if (unit.isUnderConstruction()) {
          total++;
        } else {
          total += unit.level();
        }
      }
    }
    this.myUnitsOwnedMemo.set(type, {
      version: this._myUnitsVersion,
      owned: total,
    });
    return total;
  }

  sharesBorderWith(other: Player | TerraNullius): boolean {
    const map = this.mg.map();
    const otherID = other.smallID();
    const nbuf = NEIGHBOR_SCRATCH;
    for (const border of this._borderTiles) {
      const n = map.neighbors4(border, nbuf);
      for (let i = 0; i < n; i++) {
        if (map.ownerID(nbuf[i]) === otherID) {
          return true;
        }
      }
    }
    return false;
  }

  numTilesOwned(): number {
    return this._tiles.size;
  }

  tiles(): ReadonlyTileSet {
    return this._tiles;
  }

  borderTiles(): ReadonlyTileSet {
    return this._borderTiles;
  }

  private nearbyMemo: {
    version: number;
    waterVersion: number;
    result: (Player | TerraNullius)[];
  } | null = null;

  nearby(): (Player | TerraNullius)[] {
    // Nation AI asks several times per tick (maybeAttack, attackBestTarget,
    // attackBots, ...) with no map change in between; the answer depends on
    // tile ownership and fallout (covered by territoryVersion) and on the
    // land/water/shoreline terrain. Live nuke floods mutate the latter through
    // WaterManager on the raw GameMap — bypassing GameImpl's bump — so the
    // map's waterVersion() is a second key, which every conversion advances.
    const version = this.mg.territoryVersion();
    const waterVersion = this.mg.map().waterVersion();
    if (
      this.nearbyMemo !== null &&
      this.nearbyMemo.version === version &&
      this.nearbyMemo.waterVersion === waterVersion
    ) {
      return this.nearbyMemo.result.slice();
    }
    const result = this.computeNearby();
    this.nearbyMemo = { version, waterVersion, result };
    return result.slice();
  }

  private computeNearby(): (Player | TerraNullius)[] {
    const ns: Set<Player | TerraNullius> = new Set();
    const map = this.mg.map();
    const smallID = this.smallID();
    const visit = (neighbor: TileRef) => {
      if (map.isLand(neighbor) && !map.isImpassable(neighbor)) {
        if (!map.hasOwner(neighbor) && map.hasFallout(neighbor)) {
          return;
        }
        const owner = map.ownerID(neighbor);
        if (owner !== smallID) {
          ns.add(
            this.mg.playerBySmallID(owner) satisfies Player | TerraNullius,
          );
        }
      }
    };
    for (const border of this.borderTiles()) {
      map.forEachNeighbor(border, visit);
    }
    for (const n of this.shoreReachableNeighbors()) {
      ns.add(n);
    }
    return Array.from(ns);
  }

  // Samples every 10th border tile for shore tiles, checks the tile 5 steps
  // away in each cardinal direction that immediately enters water, to detect
  // players separated by a small river (up to 4 water tiles wide)
  private shoreReachableNeighbors(): Set<Player | TerraNullius> {
    const ns: Set<Player | TerraNullius> = new Set();
    const map = this.mg.map();

    let shoreIdx = 0;
    for (const border of this.borderTiles()) {
      if (!map.isShore(border)) continue;
      // Visit every 10th shore tile.
      if (shoreIdx++ % 10 !== 0) continue;

      const bx = map.x(border);
      const by = map.y(border);

      for (let d = 0; d < 4; d++) {
        const dx = SHORE_DIRECTIONS_DX[d];
        const dy = SHORE_DIRECTIONS_DY[d];
        // Only follow directions that immediately enter water; land-adjacent
        // directions are already covered by the direct neighbors() loop.
        const x1 = bx + dx;
        const y1 = by + dy;
        if (!map.isValidCoord(x1, y1) || !map.isWater(map.ref(x1, y1)))
          continue;

        const nx = bx + dx * 5;
        const ny = by + dy * 5;
        if (!map.isValidCoord(nx, ny)) continue;
        const tile = map.ref(nx, ny);
        if (!map.isLand(tile)) continue;
        if (map.isImpassable(tile)) continue;
        if (!map.hasOwner(tile) && map.hasFallout(tile)) continue;
        const owner = map.ownerID(tile);
        if (owner !== this.smallID()) {
          ns.add(
            this.mg.playerBySmallID(owner) satisfies Player | TerraNullius,
          );
        }
      }
    }

    return ns;
  }

  isPlayer(): this is Player {
    return true as const;
  }
  setTroops(troops: number) {
    this._troops = toInt(troops);
  }
  conquer(tile: TileRef) {
    this.mg.conquer(this, tile);
  }
  orderRetreat(id: string) {
    const attack = this._outgoingAttacks.find((attack) => attack.id() === id);
    if (!attack) {
      console.warn(`Didn't find outgoing attack with id ${id}`);
      return;
    }
    attack.orderRetreat();
  }
  executeRetreat(id: string): void {
    const attack = this._outgoingAttacks.find((attack) => attack.id() === id);
    // Execution is delayed so it's not an error that the attack does not exist.
    if (!attack) {
      return;
    }
    attack.executeRetreat();
  }
  relinquish(tile: TileRef) {
    if (this.mg.owner(tile) !== this) {
      throw new Error(`Cannot relinquish tile not owned by this player`);
    }
    this.mg.relinquish(tile);
  }
  info(): PlayerInfo {
    return this.playerInfo;
  }

  isLobbyCreator(): boolean {
    return this.playerInfo.isLobbyCreator;
  }

  isAlive(): boolean {
    return this._tiles.size > 0;
  }

  hasSpawned(): boolean {
    return this._spawnTile !== undefined;
  }

  setSpawnTile(spawnTile: TileRef): void {
    this._spawnTile = spawnTile;
  }

  spawnTile(): TileRef | undefined {
    return this._spawnTile;
  }

  incomingAllianceRequests(): AllianceRequest[] {
    return this.mg.allianceRequests.filter((ar) => ar.recipient() === this);
  }

  outgoingAllianceRequests(): AllianceRequest[] {
    return this.mg.allianceRequests.filter((ar) => ar.requestor() === this);
  }

  alliances(): MutableAlliance[] {
    return this._alliances;
  }

  expiredAlliances(): Alliance[] {
    return [...this._expiredAlliances];
  }

  allies(): Player[] {
    return this.alliances().map((a) => a.other(this));
  }

  isAlliedWith(other: Player): boolean {
    if (other === this) {
      return false;
    }
    return this.allianceWith(other) !== null;
  }

  allianceWith(other: Player): MutableAlliance | null {
    if (other === this) {
      return null;
    }
    return (
      this.alliances().find(
        (a) => a.recipient() === other || a.requestor() === other,
      ) ?? null
    );
  }

  allianceInfo(other: Player): AllianceInfo | null {
    const alliance = this.allianceWith(other);
    if (!alliance) {
      return null;
    }
    const inExtensionWindow =
      alliance.expiresAt() <=
      this.mg.ticks() + this.mg.config().allianceExtensionPromptOffset();
    const canExtend =
      !this.isDisconnected() &&
      !other.isDisconnected() &&
      this.isAlive() &&
      other.isAlive() &&
      inExtensionWindow &&
      !alliance.agreedToExtend(this);
    return {
      expiresAt: alliance.expiresAt(),
      inExtensionWindow,
      myPlayerAgreedToExtend: alliance.agreedToExtend(this),
      otherAgreedToExtend: alliance.agreedToExtend(other),
      canExtend,
    };
  }

  canSendAllianceRequest(other: Player): boolean {
    if (this.mg.config().disableAlliances()) {
      return false;
    }
    if (other === this) {
      return false;
    }
    if (this.isDisconnected() || other.isDisconnected()) {
      // Disconnected players are marked as not-friendly even if they are allies,
      // so we need to return early if either player is disconnected.
      // Otherwise we could end up sending an alliance request to someone
      // we are already allied with.
      return false;
    }
    if (this.isFriendly(other) || !this.isAlive()) {
      return false;
    }

    const hasPending = this.outgoingAllianceRequests().some(
      (ar) => ar.recipient() === other,
    );

    if (hasPending) {
      return false;
    }

    const hasIncoming = this.incomingAllianceRequests().some(
      (ar) => ar.requestor() === other,
    );

    if (hasIncoming) {
      return true;
    }

    const recent = this.pastOutgoingAllianceRequests
      .filter((ar) => ar.recipient() === other)
      .sort((a, b) => b.createdAt() - a.createdAt());

    if (recent.length === 0) {
      return true;
    }

    const delta = this.mg.ticks() - recent[0].createdAt();

    return delta >= this.mg.config().allianceRequestCooldown();
  }

  breakAlliance(alliance: MutableAlliance): void {
    this.mg.breakAlliance(this, alliance);
  }

  removeAllAlliances(): void {
    this.mg.removeAlliancesByPlayerSilently(this);
  }

  isTraitor(): boolean {
    return this.getTraitorRemainingTicks() > 0;
  }

  getTraitorRemainingTicks(): number {
    if (this.markedTraitorTick < 0) return 0;
    const elapsed = this.mg.ticks() - this.markedTraitorTick;
    const duration = this.mg.config().traitorDuration();
    const remaining = duration - elapsed;
    return remaining > 0 ? remaining : 0;
  }

  markTraitor(): void {
    this.markedTraitorTick = this.mg.ticks();
    this._betrayalCount++; // Keep count for Nations too

    // Record stats (only for real Humans)
    this.mg.stats().betray(this);
  }

  // A dead player is never "in doomsday clock": nothing clears the mark on death
  // (the execution only processes alive contenders), so gate on isAlive() to
  // avoid a stuck skull/panel and per-tick update churn for eliminated players.
  inDoomsdayClock(): boolean {
    return this.isAlive() && this.markedDoomsdayClockTick >= 0;
  }

  // Ticks spent continuously below the doomsday-clock bar (0 when not marked or dead).
  doomsdayClockTicks(): number {
    return this.inDoomsdayClock()
      ? this.mg.ticks() - this.markedDoomsdayClockTick
      : 0;
  }

  enterDoomsdayClock(): void {
    if (this.markedDoomsdayClockTick < 0) {
      this.markedDoomsdayClockTick = this.mg.ticks();
    }
  }

  clearDoomsdayClock(): void {
    this.markedDoomsdayClockTick = -1;
    this.rottedAtTick = -1;
  }

  markRotted(): void {
    this.rottedAtTick = this.mg.ticks();
  }

  // Territory actively rotting. Stamped by the execution rather than derived from
  // troops vs the floor: that is a knife-edge equality (the drain lands exactly ON
  // the floor) and the floor moves as rot shrinks the cap, so a client-side copy
  // flickers.
  isDecaying(): boolean {
    if (!this.inDoomsdayClock() || this.rottedAtTick < 0) return false;
    return this.mg.ticks() - this.rottedAtTick <= DECAY_CUE_GRACE_TICKS;
  }

  betrayals(): number {
    return this._betrayalCount;
  }

  createAllianceRequest(recipient: Player): AllianceRequest | null {
    if (this.isAlliedWith(recipient)) {
      throw new Error(`cannot create alliance request, already allies`);
    }
    return this.mg.createAllianceRequest(this, recipient satisfies Player);
  }

  relation(other: Player): Relation {
    if (other === this) {
      throw new Error(`cannot get relation with self: ${this}`);
    }
    const relation = this.relations.get(other) ?? 0;
    return this.relationFromValue(relation);
  }

  relationScore(other: Player): number {
    if (other === this)
      throw new Error(`cannot get relation with self: ${this}`);
    return this.relations.get(other) ?? 0;
  }

  trust(other: Player): number {
    if (other === this) throw new Error(`cannot get trust with self: ${this}`);
    return this.diplomaticTrust.get(other.id()) ?? 50;
  }

  changeTrust(other: Player, delta: number): void {
    if (!isDiplomacyPlusParticipant(this) || !isDiplomacyPlusParticipant(other))
      return;
    if (other === this)
      throw new Error(`cannot update trust with self: ${this}`);
    this.diplomaticTrust.set(
      other.id(),
      within(this.trust(other) + delta, 0, 100),
    );
    this.cachedDiplomaticRelations = undefined;
  }

  perceivedThreat(other: Player, sharesBorder?: boolean): number {
    if (other === this) return 0;
    const ownPower = Math.max(1, this.troops() + this.numTilesOwned() * 20);
    const otherPower = other.troops() + other.numTilesOwned() * 20;
    const powerPressure = Math.min(30, (otherPower / ownPower) * 12);
    const borderPressure =
      (sharesBorder ?? this.sharesBorderWith(other)) ? 12 : 0;
    const hostility = Math.max(0, -this.relationScore(other)) * 0.2;
    return within(
      Math.round(
        other.threat() * 0.45 + powerPressure + borderPressure + hostility,
      ),
      0,
      100,
    );
  }

  rememberDiplomaticEvent(
    other: Player,
    type: DiplomaticMemoryType,
    opinionImpact: number,
    trustImpact: number,
    options: DiplomaticMemoryOptions = {},
  ): void {
    if (!isDiplomacyPlusParticipant(this) || !isDiplomacyPlusParticipant(other))
      return;
    this.pruneDiplomaticMemories();
    const policy = diplomaticMemoryPolicy(type);
    const now = this.mg.ticks();
    if (policy.aggregates) {
      const existing = this.diplomaticMemory.find(
        (memory) =>
          memory.otherID === other.id() &&
          memory.type === type &&
          memory.regionID === options.regionID,
      );
      if (existing !== undefined) {
        existing.createdAt = now;
        existing.expiresAt = Math.max(
          existing.expiresAt,
          now + (options.durationTicks ?? policy.durationTicks),
        );
        existing.severity = within(
          Math.max(existing.severity, options.severity ?? policy.severity) + 8,
          0,
          100,
        );
        existing.occurrences++;
        existing.opinionImpact = within(
          existing.opinionImpact + opinionImpact,
          -100,
          100,
        );
        existing.trustImpact = within(
          existing.trustImpact + trustImpact,
          -100,
          100,
        );
        return;
      }
    }
    this.diplomaticMemory.push({
      otherID: other.id(),
      type,
      createdAt: now,
      opinionImpact,
      trustImpact,
      expiresAt: now + (options.durationTicks ?? policy.durationTicks),
      severity: within(options.severity ?? policy.severity, 0, 100),
      occurrences: 1,
      regionID: options.regionID,
    });
    if (this.diplomaticMemory.length > 24) {
      let removable = 0;
      for (let i = 1; i < this.diplomaticMemory.length; i++) {
        const candidate = this.diplomaticMemory[i];
        const current = this.diplomaticMemory[removable];
        if (
          candidate.severity < current.severity ||
          (candidate.severity === current.severity &&
            candidate.createdAt < current.createdAt)
        ) {
          removable = i;
        }
      }
      this.diplomaticMemory.splice(removable, 1);
    }
  }

  diplomaticMemories(): readonly DiplomaticMemory[] {
    this.pruneDiplomaticMemories();
    return this.diplomaticMemory;
  }

  private pruneDiplomaticMemories(): void {
    const epoch = Math.floor(this.mg.ticks() / 100);
    if (epoch === this.lastMemoryPruneEpoch) return;
    this.lastMemoryPruneEpoch = epoch;
    const now = this.mg.ticks();
    this.diplomaticMemory = this.diplomaticMemory.filter(
      (memory) => memory.expiresAt > now,
    );
  }

  grievanceScore(other: Player): number {
    return within(
      this.diplomaticMemories()
        .filter(
          (memory) =>
            memory.otherID === other.id() &&
            (memory.opinionImpact < 0 || memory.trustImpact < 0),
        )
        .reduce(
          (score, memory) =>
            score +
            memory.severity * Math.min(2, 0.75 + memory.occurrences * 0.25),
          0,
        ),
      0,
      100,
    );
  }

  private relationFromValue(relationValue: number): Relation {
    if (relationValue < -50) {
      return Relation.Hostile;
    }
    if (relationValue < 0) {
      return Relation.Distrustful;
    }
    if (relationValue < 50) {
      return Relation.Neutral;
    }
    return Relation.Friendly;
  }

  allRelationsSorted(): { player: Player; relation: Relation }[] {
    return Array.from(this.relations, ([k, v]) => ({ player: k, relation: v }))
      .filter((r) => r.player.isAlive())
      .sort((a, b) => a.relation - b.relation)
      .map((r) => ({
        player: r.player,
        relation: this.relationFromValue(r.relation),
      }));
  }

  updateRelation(other: Player, delta: number): void {
    if (other === this) {
      throw new Error(`cannot update relation with self: ${this}`);
    }
    if (!isDiplomacyPlusParticipant(this) || !isDiplomacyPlusParticipant(other))
      return;
    const relation = this.relations.get(other) ?? 0;
    const newRelation = within(relation + delta, -100, 100);
    this.relations.set(other, newRelation);
    this.cachedDiplomaticRelations = undefined;
  }

  decayRelations() {
    this.relations.forEach((r: number, p: Player) => {
      const sign = -1 * Math.sign(r);
      const delta = 0.5;
      r += sign * delta;
      if (Math.abs(r) < delta * 2) {
        r = 0;
      }
      this.relations.set(p, r);
    });
    this.cachedDiplomaticRelations = undefined;
  }

  casusBelliAgainst(other: Player): CasusBelli | null {
    const cb = this.casusBelli.get(other.id());
    if (cb === undefined) return null;
    if (cb.expiresAt <= this.mg.ticks()) {
      this.casusBelli.delete(other.id());
      return null;
    }
    return cb;
  }

  grantCasusBelli(
    other: Player,
    type: CasusBelliType,
    durationTicks = 1800,
  ): void {
    if (
      other === this ||
      !isDiplomacyPlusParticipant(this) ||
      !isDiplomacyPlusParticipant(other)
    )
      return;
    const createdAt = this.mg.ticks();
    this.casusBelli.set(other.id(), {
      type,
      targetID: other.id(),
      createdAt,
      expiresAt: createdAt + durationTicks,
    });
  }

  consumeCasusBelli(other: Player): CasusBelli | null {
    const cb = this.casusBelliAgainst(other);
    if (cb === null) return null;
    this.casusBelli.delete(other.id());
    this.authorizeWarAgainst(other, 1800, cb.type);
    return cb;
  }

  isWarAuthorizedAgainst(other: Player): boolean {
    const until = this.warAuthorizations.get(other.id()) ?? -1;
    if (until <= this.mg.ticks()) {
      this.warAuthorizations.delete(other.id());
      return false;
    }
    return true;
  }

  authorizeWarAgainst(
    other: Player,
    durationTicks = 1800,
    warGoal: CasusBelliType | null = null,
  ): void {
    if (!isDiplomacyPlusParticipant(this) || !isDiplomacyPlusParticipant(other))
      return;
    this.warAuthorizations.set(other.id(), this.mg.ticks() + durationTicks);
    if (warGoal !== null) this.warGoals.set(other.id(), warGoal);
  }

  warGoalAgainst(other: Player): CasusBelliType | null {
    if (!this.isWarAuthorizedAgainst(other)) {
      this.warGoals.delete(other.id());
      this.warGoalRegions.delete(other.id());
      this.warGoalInitialTargetTiles.delete(other.id());
      return null;
    }
    return this.warGoals.get(other.id()) ?? null;
  }

  warGoalRegionAgainst(other: Player): number | null {
    if (!this.isWarAuthorizedAgainst(other)) {
      this.warGoalRegions.delete(other.id());
      return null;
    }
    return this.warGoalRegions.get(other.id()) ?? null;
  }

  setWarGoalRegionAgainst(other: Player, regionID: number): void {
    if (!isDiplomacyPlusParticipant(this) || !isDiplomacyPlusParticipant(other))
      return;
    if (!this.isWarAuthorizedAgainst(other)) return;
    this.warGoalRegions.set(other.id(), regionID);
    if (!this.warGoalInitialTargetTiles.has(other.id())) {
      const count = this.mg.historicalRegionOwnedTiles(regionID, other);
      this.warGoalInitialTargetTiles.set(other.id(), Math.max(1, count));
    }
  }

  clearWarGoalRegionAgainst(other: Player): void {
    this.warGoalRegions.delete(other.id());
    this.warGoalInitialTargetTiles.delete(other.id());
  }

  endWarAgainst(other: Player): void {
    this.warAuthorizations.delete(other.id());
    this.warGoals.delete(other.id());
    this.warGoalRegions.delete(other.id());
    this.warGoalInitialTargetTiles.delete(other.id());
  }

  concludePeaceWith(other: Player, truceTicks = 1200): void {
    if (!isDiplomacyPlusParticipant(this) || !isDiplomacyPlusParticipant(other))
      return;
    // End both sides' active political war state and install a temporary truce.
    this.endWarAgainst(other);
    other.endWarAgainst(this);
    this.setNonAggressionPact(other, truceTicks);
    other.setNonAggressionPact(this, truceTicks);
    const expiresAt = this.mg.ticks() + truceTicks;
    this.postWarTruces.set(other.id(), expiresAt);
    (other as PlayerImpl).postWarTruces.set(this.id(), expiresAt);
    this.updateRelation(other, 20);
    other.updateRelation(this, 20);
    this.changeTrust(other, 5);
    other.changeTrust(this, 5);
    this.rememberDiplomaticEvent(other, "peace_signed", 20, 5);
    other.rememberDiplomaticEvent(this, "peace_signed", 20, 5);
  }

  truceWith(other: Player): Tick | null {
    const expiresAt = this.postWarTruces.get(other.id());
    if (expiresAt === undefined) return null;
    if (expiresAt <= this.mg.ticks()) {
      this.postWarTruces.delete(other.id());
      return null;
    }
    return expiresAt;
  }

  nonAggressionPactWith(other: Player): Tick | null {
    const expiresAt = this.nonAggressionPacts.get(other.id());
    if (expiresAt === undefined) return null;
    if (expiresAt <= this.mg.ticks()) {
      this.nonAggressionPacts.delete(other.id());
      return null;
    }
    return expiresAt;
  }

  setNonAggressionPact(other: Player, durationTicks = 3600): void {
    if (
      other === this ||
      !isDiplomacyPlusParticipant(this) ||
      !isDiplomacyPlusParticipant(other)
    )
      return;
    const expiresAt = this.mg.ticks() + durationTicks;
    this.nonAggressionPacts.set(other.id(), expiresAt);
    // Keep it bilateral even for internal AI-created treaties.
    const impl = other as PlayerImpl;
    impl.nonAggressionPacts.set(this.id(), expiresAt);
  }

  breakNonAggressionPact(other: Player): void {
    const wasActive = this.nonAggressionPactWith(other) !== null;
    const brokeTruce = this.truceWith(other) !== null;
    this.postWarTruces.delete(other.id());
    (other as PlayerImpl).postWarTruces.delete(this.id());
    this.nonAggressionPacts.delete(other.id());
    const impl = other as PlayerImpl;
    impl.nonAggressionPacts.delete(this.id());
    if (wasActive) {
      this.changeTrust(other, -30);
      other.changeTrust(this, -30);
      this.rememberDiplomaticEvent(other, "nap_broken", -15, -30);
      other.rememberDiplomaticEvent(this, "nap_broken", -25, -30);
      if (brokeTruce) {
        other.rememberDiplomaticEvent(this, "truce_broken", -35, -40, {
          severity: 95,
          durationTicks: 12000,
        });
      }
    }
  }

  tradeAgreementWith(other: Player): Tick | null {
    const expiresAt = this.tradeAgreements.get(other.id());
    if (expiresAt === undefined) return null;
    if (expiresAt <= this.mg.ticks()) {
      this.tradeAgreements.delete(other.id());
      return null;
    }
    return expiresAt;
  }

  setTradeAgreement(other: Player, durationTicks = 3600): void {
    if (
      other === this ||
      !isDiplomacyPlusParticipant(this) ||
      !isDiplomacyPlusParticipant(other) ||
      !this.canTrade(other)
    )
      return;
    const expiresAt = this.mg.ticks() + durationTicks;
    this.tradeAgreements.set(other.id(), expiresAt);
    (other as PlayerImpl).tradeAgreements.set(this.id(), expiresAt);
    this.updateRelation(other, 6);
    other.updateRelation(this, 6);
    this.changeTrust(other, 5);
    other.changeTrust(this, 5);
  }

  guarantees(other: Player): boolean {
    return this.guarantees_.has(other.id());
  }

  setGuarantee(other: Player, enabled: boolean): void {
    if (
      other === this ||
      !isDiplomacyPlusParticipant(this) ||
      !isDiplomacyPlusParticipant(other)
    )
      return;
    const wasEnabled = this.guarantees_.has(other.id());
    if (enabled) this.guarantees_.add(other.id());
    else this.guarantees_.delete(other.id());
    if (enabled && !wasEnabled) {
      other.changeTrust(this, 8);
      this.rememberDiplomaticEvent(other, "guarantee_given", 8, 3);
      other.rememberDiplomaticEvent(this, "guarantee_given", 8, 8);
    } else if (!enabled && wasEnabled) {
      other.changeTrust(this, -10);
      this.rememberDiplomaticEvent(other, "guarantee_withdrawn", -5, -5);
      other.rememberDiplomaticEvent(this, "guarantee_withdrawn", -8, -10);
    }
  }

  threat(): number {
    return this._threat;
  }

  reputation(): number {
    return this._reputation;
  }

  changeThreat(delta: number): void {
    this._threat = within(this._threat + delta, 0, 100);
  }

  changeReputation(delta: number): void {
    this._reputation = within(this._reputation + delta, 0, 100);
  }

  canTarget(other: Player): boolean {
    if (this === other) {
      return false;
    }
    if (this.isFriendly(other)) {
      return false;
    }
    for (const t of this.targets_) {
      if (this.mg.ticks() - t.tick < this.mg.config().targetCooldown()) {
        return false;
      }
    }
    return true;
  }

  target(other: Player): void {
    this.targets_.push({ tick: this.mg.ticks(), target: other });
    this.mg.target(this, other);
  }

  targets(): Player[] {
    return this.targets_
      .filter(
        (t) => this.mg.ticks() - t.tick < this.mg.config().targetDuration(),
      )
      .map((t) => t.target);
  }

  transitiveTargets(): Player[] {
    const ts = this.alliances()
      .map((a) => a.other(this))
      .flatMap((ally) => ally.targets());
    ts.push(...this.targets());
    return [...new Set(ts)] satisfies Player[];
  }

  sendEmoji(recipient: Player | typeof AllPlayers, emoji: string): void {
    if (recipient === this) {
      throw Error(`Cannot send emoji to oneself: ${this}`);
    }
    const msg: EmojiMessage = {
      message: emoji,
      senderID: this.smallID(),
      recipientID: recipient === AllPlayers ? recipient : recipient.smallID(),
      createdAt: this.mg.ticks(),
    };
    this.outgoingEmojis_.push(msg);
    this.mg.sendEmojiUpdate(msg);
  }

  outgoingEmojis(): EmojiMessage[] {
    return this.outgoingEmojis_
      .filter(
        (e) =>
          this.mg.ticks() - e.createdAt <
          this.mg.config().emojiMessageDuration(),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  canSendEmoji(recipient: Player | typeof AllPlayers): boolean {
    if (recipient === this) {
      return false;
    }
    const recipientID =
      recipient === AllPlayers ? AllPlayers : recipient.smallID();
    const prevMsgs = this.outgoingEmojis_.filter(
      (msg) => msg.recipientID === recipientID,
    );
    for (const msg of prevMsgs) {
      if (
        this.mg.ticks() - msg.createdAt <
        this.mg.config().emojiMessageCooldown()
      ) {
        return false;
      }
    }
    return true;
  }

  canSendQuickChat(recipient: Player): boolean {
    if (recipient === this) {
      return false;
    }
    const lastSentAt = this.outgoingQuickChats_.get(recipient.smallID());
    return (
      lastSentAt === undefined ||
      this.mg.ticks() - lastSentAt >= this.mg.config().quickChatCooldown()
    );
  }

  recordQuickChat(recipient: Player): void {
    this.outgoingQuickChats_.set(recipient.smallID(), this.mg.ticks());
  }

  canDonateGold(recipient: Player): boolean {
    if (recipient === this) {
      return false;
    }
    if (
      !this.isAlive() ||
      !recipient.isAlive() ||
      !this.isFriendly(recipient)
    ) {
      return false;
    }
    if (
      recipient.type() === PlayerType.Human &&
      this.mg.config().donateGold() === false
    ) {
      return false;
    }
    for (const donation of this.sentDonations) {
      if (donation.recipient === recipient) {
        if (
          this.mg.ticks() - donation.tick <
          this.mg.config().donateCooldown()
        ) {
          return false;
        }
      }
    }
    return true;
  }

  canDonateTroops(recipient: Player): boolean {
    if (recipient === this) {
      return false;
    }
    if (
      !this.isAlive() ||
      !recipient.isAlive() ||
      !this.isFriendly(recipient)
    ) {
      return false;
    }
    if (
      recipient.type() === PlayerType.Human &&
      this.mg.config().donateTroops() === false
    ) {
      return false;
    }
    for (const donation of this.sentDonations) {
      if (donation.recipient === recipient) {
        if (
          this.mg.ticks() - donation.tick <
          this.mg.config().donateCooldown()
        ) {
          return false;
        }
      }
    }
    return true;
  }

  donateTroops(recipient: Player, troops: number): boolean {
    // Defense-in-depth: canDonateTroops already checks this, but guard here too
    // to prevent self-donation if the method is called directly.
    if (recipient === this) return false;
    if (troops <= 0) return false;
    const removed = this.removeTroops(troops);
    if (removed === 0) return false;
    recipient.addTroops(removed);

    this.sentDonations.push(new Donation(recipient, this.mg.ticks()));
    this.mg.addUpdate({
      type: GameUpdateType.DonateEvent,
      donationType: "troops",
      senderId: this.id(),
      recipientId: recipient.id(),
      amount: BigInt(removed),
    });
    return true;
  }

  donateGold(recipient: Player, gold: Gold): boolean {
    // Defense-in-depth: canDonateGold already checks this, but guard here too
    // to prevent self-donation if the method is called directly.
    if (recipient === this) return false;
    if (gold <= 0n) return false;
    const removed = this.removeGold(gold);
    if (removed === 0n) return false;
    // Must be read before addGold: the recipient's balance at this instant is
    // the only chance to record how broke they were when the gold landed.
    const recipientGoldBefore = recipient.gold();
    recipient.addGold(removed);
    this.mg
      .stats()
      .goldDonationReceived(recipient, removed, recipientGoldBefore);

    this.sentDonations.push(new Donation(recipient, this.mg.ticks()));
    this.mg.addUpdate({
      type: GameUpdateType.DonateEvent,
      donationType: "gold",
      senderId: this.id(),
      recipientId: recipient.id(),
      amount: removed,
    });
    return true;
  }

  canDeleteUnit(): boolean {
    return (
      this.mg.ticks() - this.lastDeleteUnitTick >=
      this.mg.config().deleteUnitCooldown()
    );
  }

  recordDeleteUnit(): void {
    this.lastDeleteUnitTick = this.mg.ticks();
  }

  canEmbargoAll(): boolean {
    // Cooldown gate
    if (
      this.mg.ticks() - this.lastEmbargoAllTick <
      this.mg.config().embargoAllCooldown()
    ) {
      return false;
    }
    // At least one eligible player exists
    for (const p of this.mg.players()) {
      if (p.id() === this.id()) continue;
      if (p.type() === PlayerType.Bot) continue;
      if (this.isOnSameTeam(p)) continue;
      return true;
    }
    return false;
  }

  recordEmbargoAll(): void {
    this.lastEmbargoAllTick = this.mg.ticks();
  }

  hasEmbargoAgainst(other: Player): boolean {
    return this.embargoes.has(other.id());
  }

  canTrade(other: Player): boolean {
    if (!isDiplomacyPlusParticipant(this) || !isDiplomacyPlusParticipant(other))
      return false;
    const embargo =
      other.hasEmbargoAgainst(this) || this.hasEmbargoAgainst(other);
    return !embargo && other.id() !== this.id();
  }

  getEmbargoes(): Embargo[] {
    return [...this.embargoes.values()];
  }

  addEmbargo(other: Player, isTemporary: boolean): void {
    const embargo = this.embargoes.get(other.id());
    if (embargo !== undefined && !embargo.isTemporary) return;

    this.mg.addUpdate({
      type: GameUpdateType.EmbargoEvent,
      event: "start",
      playerID: this.smallID(),
      embargoedID: other.smallID(),
    });

    this.embargoes.set(other.id(), {
      createdAt: this.mg.ticks(),
      isTemporary: isTemporary,
      target: other,
    });
  }

  stopEmbargo(other: Player): void {
    this.embargoes.delete(other.id());
    this.mg.addUpdate({
      type: GameUpdateType.EmbargoEvent,
      event: "stop",
      playerID: this.smallID(),
      embargoedID: other.smallID(),
    });
  }

  endTemporaryEmbargo(other: Player): void {
    const embargo = this.embargoes.get(other.id());
    if (embargo !== undefined && !embargo.isTemporary) return;

    this.stopEmbargo(other);
  }

  tradingPartners(): Player[] {
    return this.mg
      .players()
      .filter((other) => other !== this && this.canTrade(other));
  }

  team(): Team | null {
    return this._team;
  }

  isOnSameTeam(other: Player): boolean {
    if (other === this) {
      return false;
    }
    if (this.team() === null || other.team() === null) {
      return false;
    }
    if (this.team() === ColoredTeams.Bot || other.team() === ColoredTeams.Bot) {
      return false;
    }
    return this._team === other.team();
  }

  isFriendly(other: Player, treatAFKFriendly: boolean = false): boolean {
    if (other === this) {
      return true;
    }
    if (other.isDisconnected() && !treatAFKFriendly) {
      return false;
    }
    return this.isOnSameTeam(other) || this.isAlliedWith(other);
  }

  gold(): Gold {
    return this._gold;
  }

  tradeGold(): Gold {
    return this._tradeGold;
  }

  addTradeGold(toAdd: Gold): void {
    this._tradeGold += toAdd;
  }

  trainGold(): Gold {
    return this._trainGold;
  }

  addTrainGold(toAdd: Gold): void {
    this._trainGold += toAdd;
  }

  piracyGold(): Gold {
    return this._piracyGold;
  }

  addPiracyGold(toAdd: Gold): void {
    this._piracyGold += toAdd;
  }

  goldEarned(): Gold {
    return this._goldEarned;
  }

  addGold(toAdd: Gold, tile?: TileRef): void {
    this._gold += toAdd;
    // Every gold grant flows through here (workers, trade, trains, piracy,
    // conquest, donations) — track lifetime income for the leaderboard's
    // "Gold Income/min" column. Starting gold is assigned directly to the
    // field in the constructor and deliberately does not count as income.
    this._goldEarned += toAdd;
    if (tile) {
      this.mg.addUpdate({
        type: GameUpdateType.BonusEvent,
        player: this.id(),
        tile,
        gold: Number(toAdd),
        troops: 0,
      });
    }
  }

  removeGold(toRemove: Gold): Gold {
    if (toRemove <= 0n) {
      return 0n;
    }
    const actualRemoved = minInt(this._gold, toRemove);
    this._gold -= actualRemoved;
    return actualRemoved;
  }

  resources(): StrategicResources {
    return { food: this._food, materials: this._materials, fuel: this._fuel };
  }

  resourceConsumption(): StrategicResources {
    const tiles = this.numTilesOwned();
    const troops = this.troops();
    const activeAttackTroops = this.outgoingAttacks().reduce(
      (sum, attack) => sum + attack.troops(),
      0,
    );
    return {
      food: Math.max(0.5, tiles * 0.018 + troops / 12_000),
      materials: Math.max(0.2, tiles * 0.004 + this.units().length * 0.06),
      fuel: Math.max(
        0.1,
        this.unitCount(UnitType.Warship) * 0.12 + activeAttackTroops / 80_000,
      ),
    };
  }

  addResources(toAdd: StrategicResources): void {
    const cap = PlayerImpl.RESOURCE_CAP;
    this._food = Math.max(0, Math.min(cap, this._food + toAdd.food));
    this._materials = Math.max(
      0,
      Math.min(cap, this._materials + toAdd.materials),
    );
    this._fuel = Math.max(0, Math.min(cap, this._fuel + toAdd.fuel));
  }

  removeResource(resource: StrategicResource, amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const current = this.resources()[resource];
    if (current + 1e-9 < amount) return false;
    if (resource === "food") this._food = Math.max(0, this._food - amount);
    if (resource === "materials")
      this._materials = Math.max(0, this._materials - amount);
    if (resource === "fuel") this._fuel = Math.max(0, this._fuel - amount);
    return true;
  }

  tradeContracts(): readonly TradeContract[] {
    return Array.from(this.tradeContracts_.values());
  }

  addTradeContract(contract: TradeContract): boolean {
    if (!isDiplomacyPlusParticipant(this)) return false;
    if (this.tradeContracts_.has(contract.id)) return false;
    this.tradeContracts_.set(contract.id, contract);
    return true;
  }

  cancelTradeContract(contractID: string): boolean {
    const contract = this.tradeContracts_.get(contractID);
    if (contract === undefined || contract.status !== "active") return false;
    contract.status = "cancelled";
    return true;
  }

  processTradeContracts(): void {
    for (const contract of this.tradeContracts_.values()) {
      if (
        contract.status !== "active" ||
        contract.sellerID !== this.id() ||
        contract.nextDeliveryAt > this.mg.ticks()
      ) {
        continue;
      }
      if (!this.isAlive() || !this.mg.hasPlayer(contract.buyerID)) {
        contract.status = "failed";
        contract.lastFailure = "partner_unavailable";
        continue;
      }
      const buyer = this.mg.player(contract.buyerID);
      if (!buyer.isAlive()) {
        contract.status = "failed";
        contract.lastFailure = "partner_unavailable";
        continue;
      }
      if (!this.canTrade(buyer)) {
        contract.status = "failed";
        contract.lastFailure = "embargo";
        this.changeTrust(buyer, -5);
        buyer.changeTrust(this, -5);
        this.rememberDiplomaticEvent(buyer, "trade_failed", -3, -5);
        buyer.rememberDiplomaticEvent(this, "trade_failed", -3, -5);
        continue;
      }
      const price = BigInt(contract.pricePerDelivery);
      if (this.resources()[contract.resource] < contract.amountPerDelivery) {
        contract.status = "failed";
        contract.lastFailure = "insufficient_stock";
        continue;
      }
      if (buyer.gold() < price) {
        contract.status = "failed";
        contract.lastFailure = "insufficient_funds";
        continue;
      }

      // All preconditions are checked before either balance changes.
      if (!this.removeResource(contract.resource, contract.amountPerDelivery)) {
        contract.status = "failed";
        contract.lastFailure = "insufficient_stock";
        continue;
      }
      buyer.removeGold(price);
      this.addGold(price);
      buyer.addResources({
        food: contract.resource === "food" ? contract.amountPerDelivery : 0,
        materials:
          contract.resource === "materials" ? contract.amountPerDelivery : 0,
        fuel: contract.resource === "fuel" ? contract.amountPerDelivery : 0,
      });
      contract.deliveredCount++;
      contract.deliveriesRemaining--;
      contract.lastFailure = undefined;
      if (contract.deliveriesRemaining <= 0) {
        contract.status = "completed";
        this.rememberDiplomaticEvent(buyer, "trade_completed", 5, 4);
        buyer.rememberDiplomaticEvent(this, "trade_completed", 5, 4);
      } else {
        contract.nextDeliveryAt += contract.intervalTicks;
      }
      this.updateRelation(buyer, 1);
      buyer.updateRelation(this, 1);
      this.changeTrust(buyer, 1);
      buyer.changeTrust(this, 1);
    }
  }

  provideEconomicAid(other: Player, amount: Gold): boolean {
    if (
      other === this ||
      !isDiplomacyPlusParticipant(this) ||
      !isDiplomacyPlusParticipant(other) ||
      !other.isAlive() ||
      amount <= 0n ||
      this.gold() < amount ||
      this.mg.ticks() - (this.lastEconomicAid.get(other.id()) ?? -10_000) < 600
    ) {
      return false;
    }
    this.removeGold(amount);
    other.addGold(amount);
    this.lastEconomicAid.set(other.id(), this.mg.ticks());
    other.updateRelation(this, 8);
    other.changeTrust(this, 6);
    this.rememberDiplomaticEvent(other, "economic_aid", 4, 3);
    other.rememberDiplomaticEvent(this, "economic_aid", 8, 6);
    return true;
  }

  launchJointProject(other: Player): boolean {
    const cost = 400n;
    if (
      other === this ||
      !isDiplomacyPlusParticipant(this) ||
      !isDiplomacyPlusParticipant(other) ||
      !other.isAlive() ||
      !this.canTrade(other) ||
      this.gold() < cost ||
      other.gold() < cost ||
      this.mg.ticks() - (this.lastJointProject.get(other.id()) ?? -10_000) <
        1800
    ) {
      return false;
    }
    this.removeGold(cost);
    other.removeGold(cost);
    this.addResources({ food: 0, materials: 75, fuel: 0 });
    other.addResources({ food: 0, materials: 75, fuel: 0 });
    this.lastJointProject.set(other.id(), this.mg.ticks());
    (other as PlayerImpl).lastJointProject.set(this.id(), this.mg.ticks());
    this.updateRelation(other, 8);
    other.updateRelation(this, 8);
    this.changeTrust(other, 6);
    other.changeTrust(this, 6);
    this.rememberDiplomaticEvent(other, "joint_project", 8, 6);
    other.rememberDiplomaticEvent(this, "joint_project", 8, 6);
    return true;
  }

  diplomaticCrises(): readonly DiplomaticCrisis[] {
    return Array.from(this.diplomaticCrises_.values());
  }

  startDiplomaticCrisis(other: Player): boolean {
    if (
      other === this ||
      !isDiplomacyPlusParticipant(this) ||
      !isDiplomacyPlusParticipant(other) ||
      !other.isAlive() ||
      this.truceWith(other) !== null ||
      this.diplomaticCrises().some(
        (crisis) =>
          crisis.status === "pending" &&
          crisis.issuerID === this.id() &&
          crisis.targetID === other.id(),
      )
    ) {
      return false;
    }
    const createdAt = this.mg.ticks();
    const crisis: DiplomaticCrisis = {
      id: `${createdAt}:${this.smallID()}:${other.smallID()}`,
      issuerID: this.id(),
      targetID: other.id(),
      demand: "deescalate",
      createdAt,
      responseAt: createdAt + 50,
      deadlineAt: createdAt + 300,
      status: "pending",
    };
    this.diplomaticCrises_.set(crisis.id, crisis);
    (other as PlayerImpl).diplomaticCrises_.set(crisis.id, crisis);
    this.updateRelation(other, -8);
    other.updateRelation(this, -12);
    return true;
  }

  processDiplomaticCrises(): void {
    for (const crisis of this.diplomaticCrises_.values()) {
      if (
        crisis.status !== "pending" ||
        crisis.issuerID !== this.id() ||
        this.mg.ticks() < crisis.responseAt
      ) {
        continue;
      }
      if (!this.mg.hasPlayer(crisis.targetID)) {
        crisis.status = "cancelled";
        continue;
      }
      const target = this.mg.player(crisis.targetID);
      if (!target.isAlive() || this.truceWith(target) !== null) {
        crisis.status = "cancelled";
        continue;
      }
      const pressure = target.threat() + (100 - target.reputation());
      const leverage = this.troops() / Math.max(1, target.troops());
      const complies =
        target.type() === PlayerType.Nation &&
        pressure >= 45 &&
        leverage >= 1.15 &&
        target.relation(this) !== Relation.Hostile;
      if (complies) {
        crisis.status = "complied";
        target.changeThreat(-15);
        target.changeReputation(8);
        target.updateRelation(this, -5);
        this.rememberDiplomaticEvent(target, "crisis_complied", 3, 2);
        target.rememberDiplomaticEvent(this, "crisis_complied", -5, 0);
      } else if (
        target.type() === PlayerType.Nation ||
        this.mg.ticks() >= crisis.deadlineAt
      ) {
        crisis.status = "refused";
        this.grantCasusBelli(target, CasusBelliType.Containment, 1800);
        this.updateRelation(target, -15);
        target.updateRelation(this, -20);
        this.rememberDiplomaticEvent(target, "crisis_refused", -15, -8);
        target.rememberDiplomaticEvent(this, "crisis_refused", -20, -8);
      }
    }
  }

  offerCrisisConcession(issuer: Player): boolean {
    const crisis = this.diplomaticCrises().find(
      (candidate) =>
        candidate.status === "pending" &&
        candidate.issuerID === issuer.id() &&
        candidate.targetID === this.id(),
    );
    if (crisis === undefined || this.gold() < 300n) return false;
    this.removeGold(300n);
    issuer.addGold(300n);
    crisis.status = "complied";
    this.changeThreat(-10);
    issuer.updateRelation(this, 6);
    issuer.changeTrust(this, 4);
    this.rememberDiplomaticEvent(issuer, "crisis_complied", -3, 1);
    issuer.rememberDiplomaticEvent(this, "crisis_complied", 6, 4);
    return true;
  }

  mediateCrisisInvolving(other: Player): boolean {
    const crisis = other
      .diplomaticCrises()
      .find(
        (candidate) =>
          candidate.status === "pending" &&
          candidate.issuerID !== this.id() &&
          candidate.targetID !== this.id(),
      );
    if (crisis === undefined) return false;
    if (
      !this.mg.hasPlayer(crisis.issuerID) ||
      !this.mg.hasPlayer(crisis.targetID)
    ) {
      return false;
    }
    const issuer = this.mg.player(crisis.issuerID);
    const target = this.mg.player(crisis.targetID);
    if (issuer.trust(this) < 55 || target.trust(this) < 55) return false;
    crisis.status = "cancelled";
    issuer.updateRelation(target, 5);
    target.updateRelation(issuer, 5);
    issuer.changeTrust(this, 2);
    target.changeTrust(this, 2);
    issuer.rememberDiplomaticEvent(this, "mediation_accepted", 5, 4);
    target.rememberDiplomaticEvent(this, "mediation_accepted", 5, 4);
    return true;
  }

  stability(): number {
    return this._stability;
  }

  publicSatisfaction(): number {
    return this._publicSatisfaction;
  }

  taxPolicy(): TaxPolicy {
    return this._taxPolicy;
  }

  setTaxPolicy(policy: TaxPolicy): void {
    if (!isDiplomacyPlusParticipant(this)) return;
    this._taxPolicy = policy;
  }

  taxIncomeMultiplierPercent(): number {
    if (this._taxPolicy === "very_low") return 60;
    if (this._taxPolicy === "low") return 80;
    if (this._taxPolicy === "high") return 125;
    if (this._taxPolicy === "very_high") return 155;
    return 100;
  }

  mobilizationTarget(): number {
    return this._mobilizationTarget;
  }

  setMobilizationTarget(percent: number): void {
    if (!isDiplomacyPlusParticipant(this)) return;
    if (!Number.isFinite(percent)) return;
    this._mobilizationTarget = Math.round(within(percent, 0, 100));
  }

  updateDomesticPolitics(): void {
    if (!isDiplomacyPlusParticipant(this)) return;
    const stocks = this.resources();
    const shortagePenalty =
      (stocks.food <= 0 ? 18 : 0) +
      (stocks.materials <= 0 ? 6 : 0) +
      (stocks.fuel <= 0 ? 8 : 0);
    const warPenalty = this.outgoingAttacks().length > 0 ? 8 : 0;
    const taxEffect =
      this._taxPolicy === "very_low"
        ? 16
        : this._taxPolicy === "low"
          ? 8
          : this._taxPolicy === "high"
            ? -12
            : this._taxPolicy === "very_high"
              ? -24
              : 0;
    const satisfactionTarget = within(
      65 + taxEffect - shortagePenalty - warPenalty,
      0,
      100,
    );
    this._publicSatisfaction = within(
      this._publicSatisfaction +
        Math.sign(satisfactionTarget - this._publicSatisfaction),
      0,
      100,
    );
    const stabilityTarget = (this._publicSatisfaction + this._reputation) / 2;
    this._stability = within(
      this._stability + Math.sign(stabilityTarget - this._stability) * 0.5,
      0,
      100,
    );
    if (this.type() === PlayerType.Nation) {
      if (this._stability < 25) this._taxPolicy = "very_low";
      else if (this._stability < 35) this._taxPolicy = "low";
      else if (this.gold() < 500n && this._stability > 60)
        this._taxPolicy = this._stability > 78 ? "very_high" : "high";
      else if (this._stability > 50) this._taxPolicy = "normal";
      this.setMobilizationTarget(
        this.incomingAttacks().length > 0 || this.outgoingAttacks().length > 0
          ? 95
          : this.threat() >= 60
            ? 80
            : this._stability < 35
              ? 35
              : 60,
      );
    }
    if (this.mg.ticks() >= this._governmentTermEndsAt) {
      const styles: GovernmentStyle[] = [
        "hawkish",
        "pragmatic",
        "cooperative",
        "cautious",
      ];
      this._governmentGeneration++;
      const current = styles.indexOf(this._governmentStyle);
      this._governmentStyle =
        styles[(current + 1 + this.smallID()) % styles.length];
      this._governmentTermEndsAt = this.mg.ticks() + 3600;
      this._stability = within(this._stability - 3, 0, 100);
    }
  }

  governmentProfile(): GovernmentProfile {
    const modifiers: Record<
      GovernmentStyle,
      { tradeBias: number; riskTolerance: number }
    > = {
      hawkish: { tradeBias: -0.05, riskTolerance: 0.8 },
      pragmatic: { tradeBias: 0.05, riskTolerance: 0.55 },
      cooperative: { tradeBias: 0.15, riskTolerance: 0.35 },
      cautious: { tradeBias: 0, riskTolerance: 0.2 },
    };
    return {
      leaderName: `Government ${this._governmentGeneration}`,
      style: this._governmentStyle,
      generation: this._governmentGeneration,
      termEndsAt: this._governmentTermEndsAt,
      ...modifiers[this._governmentStyle],
    };
  }

  nationalInterests(): NationalInterests {
    const epoch = Math.floor(this.mg.ticks() / 60);
    if (this.cachedNationalInterests?.epoch === epoch) {
      return this.cachedNationalInterests.value;
    }
    const production = this.mg.resourceProduction(this);
    const consumption = this.resourceConsumption();
    const resourceAccess = (["food", "materials", "fuel"] as const)
      .map((resource) => ({
        resource,
        balance: production[resource] - consumption[resource],
        stock: this.resources()[resource],
      }))
      .sort((a, b) => a.balance - b.balance || a.stock - b.stock)[0].resource;
    const style = this.governmentProfile().style;
    const value: NationalInterests = {
      security: within(
        Math.round(100 - this._stability + (style === "cautious" ? 20 : 0)),
        0,
        100,
      ),
      expansion: within(
        Math.round(this._threat * 0.6 + (style === "hawkish" ? 25 : 5)),
        0,
        100,
      ),
      resourceAccess,
      preferredPartners: this.mg
        .players()
        .filter(
          (other) =>
            other !== this &&
            other.isAlive() &&
            isDiplomacyPlusParticipant(other),
        )
        .sort(
          (a, b) =>
            this.trust(b) - this.trust(a) ||
            this.relationScore(b) - this.relationScore(a),
        )
        .slice(0, 3)
        .map((other) => other.id()),
    };
    this.cachedNationalInterests = { epoch, value };
    return value;
  }

  nationalAgenda(): NationalAgenda {
    return this.nationalAgenda_ ?? EMPTY_NATIONAL_AGENDA;
  }

  refreshNationalAgenda(force = false): void {
    if (!isDiplomacyPlusParticipant(this) || !this.isAlive()) return;
    if (
      !force &&
      this.nationalAgenda_ !== undefined &&
      this.mg.ticks() < this.nationalAgenda_.reevaluateAt
    ) {
      return;
    }
    this.nationalAgenda_ = buildNationalAgenda(
      this.mg,
      this,
      this.nationalAgenda_,
    );
  }

  troops(): number {
    return Number(this._troops);
  }

  addTroops(troops: number): void {
    if (troops < 0) {
      this.removeTroops(-1 * troops);
      return;
    }
    this._troops += toInt(troops);
  }
  removeTroops(troops: number): number {
    if (troops <= 0) {
      return 0;
    }
    const toRemove = minInt(this._troops, toInt(troops));
    this._troops -= toRemove;
    return Number(toRemove);
  }

  captureUnit(unit: Unit): void {
    if (unit.owner() === this) {
      throw new Error(`Cannot capture unit, ${this} already owns ${unit}`);
    }
    unit.setOwner(this);
  }

  buildUnit<T extends UnitType>(
    type: T,
    spawnTile: TileRef,
    params: UnitParams<T>,
  ): Unit {
    if (this.mg.config().isUnitDisabled(type)) {
      throw new Error(
        `Attempted to build disabled unit ${type} at tile ${spawnTile} by player ${this.name()}`,
      );
    }

    const cost = this.mg.unitInfo(type).cost(this.mg, this);
    const b = new UnitImpl(
      type,
      this.mg,
      spawnTile,
      this.mg.nextUnitID(),
      this,
      params,
    );
    this._units.push(b);
    this._myUnitsVersion++;
    this.recordUnitConstructed(type);
    this.removeGold(cost);
    this.removeTroops("troops" in params ? (params.troops ?? 0) : 0);
    this.mg.addUpdate(b.toUpdate());
    this.mg.addUnit(b);

    return b;
  }

  public findUnitToUpgrade(type: UnitType, targetTile: TileRef): Unit | false {
    const unit = this.findExistingUnitToUpgrade(type, targetTile);
    if (unit === false || !this.canUpgradeUnit(unit)) {
      return false;
    }
    return unit;
  }

  private findExistingUnitToUpgrade(
    type: UnitType,
    targetTile: TileRef,
  ): Unit | false {
    const closest = findClosestBy(
      this.mg.nearbyUnits(
        targetTile,
        this.mg.config().structureMinDist(),
        type,
        undefined,
        true,
      ),
      (entry) => entry.distSquared,
    );

    return closest?.unit ?? false;
  }

  private canBuildUnitType(
    unitType: UnitType,
    knownCost: Gold | null = null,
  ): boolean {
    if (this.mg.config().isUnitDisabled(unitType)) {
      return false;
    }
    const cost = knownCost ?? this.mg.unitInfo(unitType).cost(this.mg, this);
    if (this._gold < cost) {
      return false;
    }
    if (unitType !== UnitType.MIRVWarhead && !this.isAlive()) {
      return false;
    }
    return true;
  }

  private canUpgradeUnitType(unitType: UnitType): boolean {
    return Boolean(this.mg.config().unitInfo(unitType).upgradable);
  }

  private isUnitValidToUpgrade(unit: Unit): boolean {
    if (unit.isUnderConstruction()) {
      return false;
    }
    if (unit.isMarkedForDeletion()) {
      return false;
    }
    if (unit.owner() !== this) {
      return false;
    }
    return true;
  }

  public canUpgradeUnit(unit: Unit): boolean {
    if (!this.canUpgradeUnitType(unit.type())) {
      return false;
    }
    if (!this.canBuildUnitType(unit.type())) {
      return false;
    }
    if (!this.isUnitValidToUpgrade(unit)) {
      return false;
    }
    return true;
  }

  upgradeUnit(unit: Unit) {
    const cost = this.mg.unitInfo(unit.type()).cost(this.mg, this);
    this.removeGold(cost);
    unit.increaseLevel();
    this.recordUnitConstructed(unit.type());
  }

  public buildableUnits(
    tile: TileRef | null,
    units: readonly PlayerBuildableUnitType[] = PlayerBuildable.types,
  ): BuildableUnit[] {
    const mg = this.mg;
    const config = mg.config();
    const rail = mg.railNetwork();
    const inSpawnPhase = mg.inSpawnPhase();

    const validTiles =
      tile !== null && units.some((u) => Structures.has(u))
        ? this.validStructureSpawnTiles(tile)
        : [];

    const len = units.length;
    const result = new Array<BuildableUnit>(len);

    for (let i = 0; i < len; i++) {
      const u = units[i];

      const cost = config.unitInfo(u).cost(mg, this);
      let canUpgrade: number | false = false;
      let canBuild: TileRef | false = false;

      if (tile !== null && this.canBuildUnitType(u, cost) && !inSpawnPhase) {
        if (this.canUpgradeUnitType(u)) {
          const existingUnit = this.findExistingUnitToUpgrade(u, tile);
          if (
            existingUnit !== false &&
            this.isUnitValidToUpgrade(existingUnit)
          ) {
            canUpgrade = existingUnit.id();
          }
        }
        canBuild = this.canSpawnUnitType(u, tile, validTiles);
      }

      const buildNew = canBuild !== false && canUpgrade === false;

      // Cumulative bulk-upgrade totals. Each upgrade raises the unit's level
      // and the constructed count, so step n costs the same as if the player
      // already had n extra units — cost(mg, this, n).
      let upgradeCosts: Gold[] | undefined;
      if (canUpgrade !== false) {
        upgradeCosts = new Array<Gold>(MAX_UPGRADE_AMOUNT);
        let total = 0n;
        for (let n = 0; n < MAX_UPGRADE_AMOUNT; n++) {
          total += config.unitInfo(u).cost(mg, this, n);
          upgradeCosts[n] = total;
        }
      }

      result[i] = {
        type: u,
        canBuild,
        canUpgrade,
        cost,
        upgradeCosts,
        overlappingRailroads: buildNew
          ? rail.overlappingRailroads(u, canBuild as TileRef)
          : [],
        ghostRailPaths: buildNew
          ? rail.computeGhostRailPaths(u, canBuild as TileRef)
          : [],
      };
    }

    return result;
  }

  canBuild(
    unitType: UnitType,
    targetTile: TileRef,
    validTiles: TileRef[] | null = null,
  ): TileRef | false {
    if (!this.canBuildUnitType(unitType)) {
      return false;
    }

    return this.canSpawnUnitType(unitType, targetTile, validTiles);
  }

  private canSpawnUnitType(
    unitType: UnitType,
    targetTile: TileRef,
    validTiles: TileRef[] | null,
  ): TileRef | false {
    switch (unitType) {
      case UnitType.MIRV:
        if (!this.mg.hasOwner(targetTile)) {
          return false;
        }
        return this.nukeSpawn(targetTile, unitType);
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
        return this.nukeSpawn(targetTile, unitType);
      case UnitType.MIRVWarhead:
        return targetTile;
      case UnitType.Port:
        return this.portSpawn(targetTile, validTiles);
      case UnitType.Warship:
        return this.warshipSpawn(targetTile);
      case UnitType.Shell:
      case UnitType.SAMMissile:
        return targetTile;
      case UnitType.TransportShip:
        return canBuildTransportShip(this.mg, this, targetTile);
      case UnitType.TradeShip:
        return this.tradeShipSpawn(targetTile);
      case UnitType.Train:
        return this.landBasedUnitSpawn(targetTile);
      case UnitType.MissileSilo:
      case UnitType.DefensePost:
      case UnitType.SAMLauncher:
      case UnitType.City:
      case UnitType.Factory:
        return this.landBasedStructureSpawn(targetTile, validTiles);
      default:
        assertNever(unitType);
    }
  }

  nukeSpawn(tile: TileRef, nukeType: UnitType): TileRef | false {
    const mg = this.mg;
    if (mg.isSpawnImmunityActive()) {
      return false;
    }
    // Impassable terrain cannot be nuked.
    if (mg.isImpassable(tile)) {
      return false;
    }
    const owner = this.mg.owner(tile);
    // Allow nuking teammates after the game is over (aftergame fun), but not in singleplayer.
    const gameOver =
      mg.getWinner() !== null &&
      mg.config().gameConfig().gameType !== GameType.Singleplayer;
    if (owner.isPlayer()) {
      if (this.isOnSameTeam(owner) && !gameOver) {
        return false;
      }
    }
    const config = mg.config();

    // Prevent launching nukes that would hit teammate structures (only in team games).
    // Disabled after game-over so players can nuke teammates in the aftergame.
    if (
      config.gameConfig().gameMode === GameMode.Team &&
      nukeType !== UnitType.MIRV &&
      !gameOver
    ) {
      const magnitude = config.nukeMagnitudes(nukeType);
      const wouldHitTeammate = mg.anyUnitNearby(
        tile,
        magnitude.outer,
        Structures.types,
        (unit) => unit.owner().isPlayer() && this.isOnSameTeam(unit.owner()),
      );
      if (wouldHitTeammate) {
        return false;
      }
    }

    // only get missilesilos that are not on cooldown and not under construction
    const readySilos = this.units(UnitType.MissileSilo).filter(
      (silo) =>
        silo.isActive() && !silo.isInCooldown() && !silo.isUnderConstruction(),
    );
    readySilos.sort(
      (a, b) =>
        mg.manhattanDist(a.tile(), tile) - mg.manhattanDist(b.tile(), tile),
    );
    return readySilos[0]?.tile() ?? false;
  }

  portSpawn(tile: TileRef, validTiles: TileRef[] | null): TileRef | false {
    const spawns = Array.from(
      this.mg.bfs(
        tile,
        manhattanDistFN(tile, this.mg.config().radiusPortSpawn()),
      ),
    )
      .filter((t) => this.mg.owner(t) === this && this.mg.isShore(t))
      .sort(
        (a, b) =>
          this.mg.manhattanDist(a, tile) - this.mg.manhattanDist(b, tile),
      );
    const validTileSet = new Set(
      validTiles ?? this.validStructureSpawnTiles(tile),
    );
    for (const t of spawns) {
      if (validTileSet.has(t)) {
        return t;
      }
    }
    return false;
  }

  warshipSpawn(tile: TileRef): TileRef | false {
    if (!this.mg.isWater(tile)) {
      return false;
    }

    const tileComponent = this.mg.getWaterComponent(tile);
    const bestPort = findClosestBy(
      this.units(UnitType.Port),
      (port) => this.mg.manhattanDist(port.tile(), tile),
      (port) =>
        port.isActive() &&
        !port.isUnderConstruction() &&
        tileComponent !== null &&
        this.mg.hasWaterComponent(port.tile(), tileComponent),
    );

    return bestPort?.tile() ?? false;
  }

  landBasedUnitSpawn(tile: TileRef): TileRef | false {
    return this.mg.isLand(tile) && !this.mg.isImpassable(tile) ? tile : false;
  }

  landBasedStructureSpawn(
    tile: TileRef,
    validTiles: TileRef[] | null = null,
  ): TileRef | false {
    const tiles = validTiles ?? this.validStructureSpawnTiles(tile);
    if (tiles.length === 0) {
      return false;
    }
    return tiles[0];
  }

  private validStructureSpawnTiles(tile: TileRef): TileRef[] {
    if (this.mg.owner(tile) !== this) {
      return [];
    }
    const searchRadius = 15;
    const searchRadiusSquared = searchRadius ** 2;

    const nearbyUnits = this.mg.nearbyUnits(
      tile,
      searchRadius * 2,
      Structures.types,
      undefined,
      true,
    );
    // Flood the player's own tiles inside the radius. Same traversal as
    // GameMap.bfs (stack, N/S/W/E push order) so `nearbyTiles` comes out in
    // the same order — the stable sort below keeps that order for ties and
    // callers take the first entry — but on the shared visited array instead
    // of a Set per call (nation placement calls this per candidate tile).
    const map = this.mg.map();
    const w = map.width();
    const cx = tile % w;
    const cy = (tile / w) | 0;
    const smallID = this.smallID();
    const inside = (t: TileRef): boolean => {
      const dx = (t % w) - cx;
      const dy = ((t / w) | 0) - cy;
      return (
        dx * dx + dy * dy < searchRadiusSquared && map.ownerID(t) === smallID
      );
    };
    const scratch = tileTraversalScratch(this.mg);
    const gen = bumpTraversalGeneration(scratch);
    const visited = scratch.visited;
    const stack = scratch.stack;
    stack.length = 0;
    const nearbyTiles: TileRef[] = [];
    if (inside(tile)) {
      visited[tile] = gen;
      nearbyTiles.push(tile);
      stack.push(tile);
    }
    const visit = (n: TileRef) => {
      if (visited[n] !== gen && inside(n)) {
        visited[n] = gen;
        nearbyTiles.push(n);
        stack.push(n);
      }
    };
    while (stack.length > 0) {
      map.forEachNeighbor(stack.pop()!, visit);
    }

    const minDistSquared = this.mg.config().structureMinDist() ** 2;
    const valid: TileRef[] = [];
    for (const t of nearbyTiles) {
      let blocked = false;
      for (const { unit } of nearbyUnits) {
        if (this.mg.euclideanDistSquared(unit.tile(), t) < minDistSquared) {
          blocked = true;
          break;
        }
      }
      if (!blocked) valid.push(t);
    }
    valid.sort(
      (a, b) =>
        this.mg.euclideanDistSquared(a, tile) -
        this.mg.euclideanDistSquared(b, tile),
    );
    return valid;
  }

  tradeShipSpawn(targetTile: TileRef): TileRef | false {
    return this.units(UnitType.Port).find((u) => u.tile() === targetTile)
      ? targetTile
      : false;
  }
  tileChangeVersion(): number {
    return this._tileChangeVersion;
  }

  lastTileChange(): Tick {
    return this._lastTileChange;
  }

  isDisconnected(): boolean {
    return this._isDisconnected;
  }

  markDisconnected(
    isDisconnected: boolean,
    snapshot?: DisconnectSnapshot,
  ): void {
    this._isDisconnected = isDisconnected;
    if (isDisconnected) {
      if (this._disconnectSnapshot === null) {
        const team = this.team();
        this._disconnectSnapshot = snapshot ?? {
          currentTick: this.mg.ticks(),
          teamTiles: team ? this.mg.teamTilesOwned(team) : 0,
          totalLand: this.mg.totalLandTiles(),
          wasAlive: this.isAlive(),
        };
      }
    } else {
      this._disconnectSnapshot = null;
    }
  }

  disconnectSnapshot(): DisconnectSnapshot | null {
    return this._disconnectSnapshot;
  }

  disconnectedAtTick(): number | null {
    return this._disconnectSnapshot?.currentTick ?? null;
  }

  hash(): number {
    const resourceHash =
      Math.round(this._food * 1000) +
      Math.round(this._materials * 1000) * 3 +
      Math.round(this._fuel * 1000) * 7;
    return (
      simpleHash(this.id()) * (this.troops() + this.numTilesOwned()) +
      resourceHash +
      this._units.reduce((acc, unit) => acc + unit.hash(), 0)
    );
  }
  toString(): string {
    return `Player:{name:${this.info().name},clientID:${
      this.info().clientID
    },isAlive:${this.isAlive()},troops:${
      this._troops
    },numTileOwned:${this.numTilesOwned()}}]`;
  }

  public playerProfile(): PlayerProfile {
    const rel = {
      relations: Object.fromEntries(
        this.allRelationsSorted().map(({ player, relation }) => [
          player.smallID(),
          relation,
        ]),
      ),
      alliances: this.alliances().map((a) => a.other(this).smallID()),
    };
    return rel;
  }

  createAttack(
    target: Player | TerraNullius,
    troops: number,
    sourceTile: TileRef | null,
    border: Set<number>,
  ): Attack {
    const attack = new AttackImpl(
      this._pseudo_random.nextID(),
      target,
      this,
      troops,
      sourceTile,
      border,
      this.mg,
    );
    this._outgoingAttacks.push(attack);
    if (target.isPlayer()) {
      (target as PlayerImpl)._incomingAttacks.push(attack);
    }
    return attack;
  }
  outgoingAttacks(): Attack[] {
    return this._outgoingAttacks;
  }
  incomingAttacks(): Attack[] {
    return this._incomingAttacks.filter((a) => a.attacker().isAlive());
  }

  public isImmune(): boolean {
    if (this.type() === PlayerType.Human) {
      return this.mg.isSpawnImmunityActive();
    }
    if (this.type() === PlayerType.Nation) {
      return this.mg.isNationSpawnImmunityActive();
    }
    return false;
  }

  public canAttackPlayer(
    player: Player,
    treatAFKFriendly: boolean = false,
  ): boolean {
    if (this.truceWith(player) !== null) return false;
    if (this.type() !== PlayerType.Human) {
      // Only human attackers respect PVP immunity
      return !this.isFriendly(player, treatAFKFriendly);
    }
    return !player.isImmune() && !this.isFriendly(player, treatAFKFriendly);
  }

  public canAttack(tile: TileRef): boolean {
    const owner = this.mg.owner(tile);
    if (owner === this) {
      return false;
    }

    if (owner.isPlayer() && !this.canAttackPlayer(owner)) {
      return false;
    }

    if (!this.mg.isLand(tile) || this.mg.isImpassable(tile)) {
      return false;
    }
    if (this.mg.hasOwner(tile)) {
      return this.sharesBorderWith(owner);
    } else {
      for (const t of this.mg.bfs(
        tile,
        andFN(
          (gm, t) => !gm.hasOwner(t) && gm.isLand(t) && !gm.isImpassable(t),
          manhattanDistFN(tile, 200),
        ),
      )) {
        for (const n of this.mg.neighbors(t)) {
          if (this.mg.owner(n) === this) {
            return true;
          }
        }
      }
      return false;
    }
  }

  bestTransportShipSpawn(targetTile: TileRef): TileRef | false {
    return bestShoreDeploymentSource(this.mg, this, targetTile) ?? false;
  }
}
