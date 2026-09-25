import { Config } from "../configuration/Config";
import { AbstractGraph } from "../pathfinding/algorithms/AbstractGraph";
import { PathFinder } from "../pathfinding/types";
import { AllPlayersStats, ClientID } from "../Schemas";
import { formatPlayerDisplayName } from "../Util";
import { GameMap, TileRef } from "./GameMap";
import {
  GameUpdate,
  GameUpdateType,
  PlayerUpdate,
  UnitUpdate,
} from "./GameUpdates";
import { MotionPlanRecord } from "./MotionPlans";
import { RailNetwork } from "./RailNetwork";
import { Stats } from "./Stats";
import { ReadonlyTileSet } from "./TileSet";
import { UnitPredicate } from "./UnitGrid";

function isEnumValue<T extends Record<string, string | number>>(
  enumObj: T,
  value: unknown,
): value is T[keyof T] {
  return Object.values(enumObj).includes(value as T[keyof T]);
}

export type PlayerID = string;
export type Tick = number;
export type Gold = bigint;

export type WarshipState = {
  state: "patrolling" | "retreating" | "docked";
  patrolTile?: TileRef;
  retreatPort?: TileRef;
  isInCombat?: boolean;
  lastCombatTick: number;
  // Veterancy level (0–max) plus a shared integer progress meter fed by
  // transport kills and trade captures (see UnitImpl.addVeterancyProgress).
  veterancy: number;
  veterancyProgress: number;
};

export type TransportShipState = {
  isRetreating: boolean;
  troops: number;
};

export type NukeState = {
  trajectory: TrajectoryTile[];
  trajectoryIndex: number;
  targetedBySam: boolean;
  waitTicks: number;
};

export type SamLauncherState = {
  upgradeStartTick?: number;
  startRange: number;
  targetLevel: number;
  duration: number;
};

export const AllPlayers = "AllPlayers" as const;

// export type GameUpdates = Record<GameUpdateType, GameUpdate[]>;
// Create a type that maps GameUpdateType to its corresponding update type
type UpdateTypeMap<T extends GameUpdateType> = Extract<GameUpdate, { type: T }>;

// Then use it to create the record type
export type GameUpdates = {
  [K in GameUpdateType]: UpdateTypeMap<K>[];
};

export interface MapPos {
  x: number;
  y: number;
}

export enum Difficulty {
  Easy = "Easy",
  Medium = "Medium",
  Hard = "Hard",
  Impossible = "Impossible",
}
export const isDifficulty = (value: unknown): value is Difficulty =>
  isEnumValue(Difficulty, value);

export type Team = string;

export interface SpawnArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TeamGameSpawnAreas = Record<string, SpawnArea[]>;

export const Duos = "Duos" as const;
export const Trios = "Trios" as const;
export const Quads = "Quads" as const;
export const HumansVsNations = "Humans Vs Nations" as const;

export const ColoredTeams: Record<string, Team> = {
  Red: "Red",
  Blue: "Blue",
  Teal: "Teal",
  Purple: "Purple",
  Yellow: "Yellow",
  Orange: "Orange",
  Green: "Green",
  Bot: "Bot",
  Humans: "Humans",
  Nations: "Nations",
} as const;

// GameMapType and the maps list are generated from
// map-generator/assets/maps/<map>/info.json by the map-generator
// (`npm run gen-maps`).
export {
  GameMapType,
  mapCategoryOrder,
  maps,
  type CustomTribe,
  type GameMapName,
  type MapCategory,
  type MapInfo,
  type SpecialModifierKey,
} from "./Maps.gen";

export const WORLD_FORMATION_END_TICK = 200;
// Keep borders politically frozen for two extra seconds while the final T=20 map is copied in small chunks.
export const WORLD_FORMATION_UNLOCK_TICK = 220;

export enum GameType {
  Singleplayer = "Singleplayer",
  Public = "Public",
  Private = "Private",
}
export const isGameType = (value: unknown): value is GameType =>
  isEnumValue(GameType, value);

export enum GameMode {
  FFA = "Free For All",
  Team = "Team",
}

export enum RankedType {
  OneVOne = "1v1",
  TwoVTwo = "2v2",
}

export const isGameMode = (value: unknown): value is GameMode =>
  isEnumValue(GameMode, value);

export enum GameMapSize {
  Compact = "Compact",
  Normal = "Normal",
}

export interface PublicGameModifiers {
  isCompact?: boolean;
  isRandomSpawn?: boolean;
  isCrowded?: boolean;
  isHardNations?: boolean;
  startingGold?: number;
  goldMultiplier?: number;
  isAlliancesDisabled?: boolean;
  isPortsDisabled?: boolean;
  isNukesDisabled?: boolean;
  isSAMsDisabled?: boolean;
  isPeaceTime?: boolean;
  isWaterNukes?: boolean;
  isDoomsdayClock?: boolean;
}

// Largest bulk-purchase amount an intent may carry (mirrored by the intent
// schemas' max). Also the length of BuildableUnit.upgradeCosts.
export const MAX_UPGRADE_AMOUNT = 50;

export interface UnitInfo {
  // extraUnits shifts the cost curve as if the player already had that many
  // additional units/levels — used to price the later steps of a bulk upgrade.
  cost: (game: Game, player: Player, extraUnits?: number) => Gold;
  maxHealth?: number;
  damage?: number;
  constructionDuration?: number;
  upgradable?: boolean;
}

function unitTypeGroup<T extends readonly UnitType[]>(types: T) {
  return {
    types,
    has(type: UnitType): type is T[number] {
      return (types as readonly UnitType[]).includes(type);
    },
  };
}

export enum UnitType {
  TransportShip = "Transport",
  Warship = "Warship",
  Shell = "Shell",
  SAMMissile = "SAMMissile",
  Port = "Port",
  AtomBomb = "Atom Bomb",
  HydrogenBomb = "Hydrogen Bomb",
  TradeShip = "Trade Ship",
  MissileSilo = "Missile Silo",
  DefensePost = "Defense Post",
  SAMLauncher = "SAM Launcher",
  City = "City",
  MIRV = "MIRV",
  MIRVWarhead = "MIRV Warhead",
  Train = "Train",
  Factory = "Factory",
}

export enum TrainType {
  Engine = "Engine",
  TailEngine = "TailEngine",
  Carriage = "Carriage",
}

export const Nukes = unitTypeGroup([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRVWarhead,
  UnitType.MIRV,
] as const);

export const BuildableAttacks = unitTypeGroup([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.Warship,
] as const);

export const Structures = unitTypeGroup([
  UnitType.City,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
  UnitType.Port,
  UnitType.Factory,
] as const);

export const BuildMenus = unitTypeGroup([
  ...Structures.types,
  ...BuildableAttacks.types,
] as const);

export const PlayerBuildable = unitTypeGroup([
  ...BuildMenus.types,
  UnitType.TransportShip,
] as const);

export type PlayerBuildableUnitType = (typeof PlayerBuildable.types)[number];

export interface OwnerComp {
  owner: Player;
}

export type TrajectoryTile = {
  tile: TileRef;
  targetable: boolean;
};
export interface UnitParamsMap {
  [UnitType.TransportShip]: {
    troops?: number;
    targetTile?: TileRef;
  };

  [UnitType.Warship]: {
    patrolTile: TileRef;
  };

  [UnitType.Shell]: Record<string, never>;

  [UnitType.SAMMissile]: {
    targetUnit: Unit;
  };

  [UnitType.Port]: Record<string, never>;

  [UnitType.AtomBomb]: {
    targetTile?: number;
    trajectory: TrajectoryTile[];
  };

  [UnitType.HydrogenBomb]: {
    targetTile?: number;
    trajectory: TrajectoryTile[];
  };

  [UnitType.MIRV]: {
    targetTile?: number;
    targetPlayer?: Player | TerraNullius;
  };

  [UnitType.MIRVWarhead]: {
    targetTile?: number;
    trajectory: TrajectoryTile[];
  };

  [UnitType.TradeShip]: {
    targetUnit: Unit;
    lastSetSafeFromPirates?: number;
  };

  [UnitType.Train]: {
    trainType: TrainType;
    targetUnit?: Unit;
    loaded?: boolean;
  };

  [UnitType.Factory]: Record<string, never>;

  [UnitType.MissileSilo]: Record<string, never>;

  [UnitType.DefensePost]: Record<string, never>;

  [UnitType.SAMLauncher]: Record<string, never>;

  [UnitType.City]: Record<string, never>;
}

// Type helper to get params type for a specific unit type
export type UnitParams<T extends UnitType> = UnitParamsMap[T];

export type AllUnitParams = UnitParamsMap[keyof UnitParamsMap];

export enum Relation {
  Hostile = 0,
  Distrustful = 1,
  Neutral = 2,
  Friendly = 3,
}

export type DiplomaticMemoryType =
  | "nap_signed"
  | "nap_broken"
  | "guarantee_given"
  | "guarantee_withdrawn"
  | "war_started"
  | "peace_signed"
  | "trade_started"
  | "trade_completed"
  | "trade_failed"
  | "economic_aid"
  | "joint_project"
  | "crisis_complied"
  | "crisis_refused"
  | "trade_ship_seized"
  | "trade_ship_destroyed"
  | "reparations_requested"
  | "reparations_paid"
  | "reparations_refused"
  | "mediation_accepted"
  | "mediation_refused"
  | "territory_lost"
  | "territory_returned"
  | "truce_broken"
  | "unjustified_war"
  | "international_condemnation"
  | "sanctions_imposed"
  | "resolution_ignored";

export interface DiplomaticMemory {
  otherID: PlayerID;
  type: DiplomaticMemoryType;
  createdAt: Tick;
  opinionImpact: number;
  trustImpact: number;
  expiresAt: Tick;
  severity: number;
  occurrences: number;
  regionID?: number;
}

export interface DiplomaticMemoryOptions {
  durationTicks?: number;
  severity?: number;
  regionID?: number;
}

export type StrategicResource = "food" | "materials" | "fuel";

export type TradeContractStatus =
  | "active"
  | "completed"
  | "cancelled"
  | "failed";

export type TradeFailureReason =
  | "insufficient_stock"
  | "insufficient_funds"
  | "partner_unavailable"
  | "embargo";

export interface TradeContract {
  id: string;
  sellerID: PlayerID;
  buyerID: PlayerID;
  resource: StrategicResource;
  amountPerDelivery: number;
  pricePerDelivery: number;
  intervalTicks: number;
  nextDeliveryAt: Tick;
  deliveriesRemaining: number;
  deliveredCount: number;
  status: TradeContractStatus;
  createdAt: Tick;
  lastFailure?: TradeFailureReason;
}

export interface DiplomaticCrisis {
  id: string;
  issuerID: PlayerID;
  targetID: PlayerID;
  demand: "deescalate";
  createdAt: Tick;
  responseAt: Tick;
  deadlineAt: Tick;
  status: "pending" | "complied" | "refused" | "cancelled";
}

export type GovernmentStyle =
  | "hawkish"
  | "pragmatic"
  | "cooperative"
  | "cautious";

export interface GovernmentProfile {
  leaderName: string;
  style: GovernmentStyle;
  generation: number;
  termEndsAt: Tick;
  tradeBias: number;
  riskTolerance: number;
}

export interface NationalInterests {
  security: number;
  expansion: number;
  resourceAccess: StrategicResource;
  preferredPartners: PlayerID[];
}

export type NationalConcernType =
  | "food_insecurity"
  | "fuel_shortage"
  | "materials_shortage"
  | "military_vulnerability"
  | "naval_vulnerability"
  | "commercial_dependence"
  | "powerful_neighbour"
  | "lost_territory"
  | "diplomatic_isolation"
  | "high_war_exhaustion"
  | "strategic_port_needed"
  | "trade_route_threatened";

export interface NationalConcern {
  type: NationalConcernType;
  severity: number;
  since: Tick;
  lastEvaluatedAt: Tick;
  reason: string;
  resource?: StrategicResource;
  targetID?: PlayerID;
  regionID?: number;
}

export type NationalGoalType =
  | "secure_border"
  | "protect_maritime_trade"
  | "secure_food_supply"
  | "secure_fuel_supply"
  | "build_material_reserves"
  | "control_strategic_region"
  | "obtain_port"
  | "contain_rival"
  | "strengthen_alliance"
  | "find_trade_partner"
  | "recover_lost_territory"
  | "avoid_costly_war"
  | "reduce_economic_dependence"
  | "build_national_reserves";

export interface NationalAgendaGoal {
  id: string;
  type: NationalGoalType;
  priority: number;
  createdAt: Tick;
  expiresAt: Tick;
  reason: string;
  resource?: StrategicResource;
  targetID?: PlayerID;
  regionID?: number;
}

export interface StrategicRegionInterest {
  regionID: number;
  priority: number;
  reason: string;
}

export interface NationalAgenda {
  generatedAt: Tick;
  reevaluateAt: Tick;
  goals: NationalAgendaGoal[];
  concerns: NationalConcern[];
  strategicRegions: StrategicRegionInterest[];
  rivals: PlayerID[];
  preferredPartners: PlayerID[];
}

export enum CasusBelliType {
  Retaliation = "retaliation",
  BorderClaim = "border_claim",
  TreatyViolation = "treaty_violation",
  Containment = "containment",
}

export interface CasusBelli {
  type: CasusBelliType;
  targetID: PlayerID;
  createdAt: Tick;
  expiresAt: Tick;
}

export class Nation {
  constructor(
    public readonly spawnCell: Cell | undefined,
    public readonly playerInfo: PlayerInfo,
  ) {}
}

export class Cell {
  public index: number;

  private strRepr: string;

  constructor(
    public readonly x: number,
    public readonly y: number,
  ) {
    this.strRepr = `Cell[${this.x},${this.y}]`;
  }

  pos(): MapPos {
    return {
      x: this.x,
      y: this.y,
    };
  }

  toString(): string {
    return this.strRepr;
  }
}

export enum TerrainType {
  Plains,
  Highland,
  Mountain,
  Ocean,
  Impassable,
}

export enum PlayerType {
  Bot = "BOT",
  Human = "HUMAN",
  Nation = "NATION",
}

/**
 * Diplomacy+ models sovereign countries. Vanilla bots are temporary tribes
 * used to populate the map and deliberately stay outside these systems.
 */
export function isDiplomacyPlusParticipant(player: {
  type(): PlayerType;
}): boolean {
  return (
    player.type() === PlayerType.Human || player.type() === PlayerType.Nation
  );
}

export interface Execution {
  isActive(): boolean;
  activeDuringSpawnPhase(): boolean;
  applyDuringPause?(): boolean;
  init(mg: Game, ticks: number): void;
  tick(ticks: number): void;
}

export interface Attack {
  id(): string;
  retreating(): boolean;
  retreated(): boolean;
  orderRetreat(): void;
  executeRetreat(): void;
  target(): Player | TerraNullius;
  attacker(): Player;
  troops(): number;
  setTroops(troops: number): void;
  isActive(): boolean;
  delete(): void;
  // The tile the attack originated from, mostly used for boat attacks.
  sourceTile(): TileRef | null;
  addBorderTile(tile: TileRef): void;
  removeBorderTile(tile: TileRef): void;
  clearBorder(): void;
  borderSize(): number;
  clusteredPositions(): TileRef[];
}

export interface AllianceRequest {
  accept(): void;
  reject(): void;
  requestor(): Player;
  recipient(): Player;
  createdAt(): Tick;
  status(): "pending" | "accepted" | "rejected";
}

export interface Alliance {
  requestor(): Player;
  recipient(): Player;
  createdAt(): Tick;
  expiresAt(): Tick;
  other(player: Player): Player;
}

export interface MutableAlliance extends Alliance {
  expire(): void;
  other(player: Player): Player;
  bothAgreedToExtend(): boolean;
  addExtensionRequest(player: Player): void;
  id(): number;
  extend(): void;
  onlyOneAgreedToExtend(): boolean;

  agreedToExtend(player: Player): boolean;
}

export class PlayerInfo {
  public readonly displayName: string;

  constructor(
    public readonly name: string,
    public readonly playerType: PlayerType,
    // null if tribe.
    public readonly clientID: ClientID | null,
    // TODO: make player id the small id
    public readonly id: PlayerID,
    public readonly isLobbyCreator: boolean = false,
    public readonly clanTag: string | null = null,
    public readonly friends: ClientID[] = [],
    // Server-pinned team slot (index into the game's team list) for
    // matchmade team games; null = assign normally.
    public readonly teamIndex: number | null = null,
    // Manifest flag code (e.g. "in", "pk") for PlayerType.Nation players.
    // Carried from the map manifest through to the client so it can render
    // the correct flag even when multiple nations on a map share a display
    // name (e.g. India's and Pakistan's "Punjab").
    public readonly nationFlag: string | null = null,
  ) {
    this.displayName = formatPlayerDisplayName(this.name, this.clanTag);
  }
}

export function isUnit(unit: unknown): unit is Unit {
  return (
    unit &&
    typeof unit === "object" &&
    "isUnit" in unit &&
    typeof unit.isUnit === "function" &&
    unit.isUnit()
  );
}

export interface Unit {
  isUnit(): this is Unit;

  // Common properties.
  id(): number;
  type(): UnitType;
  owner(): Player;
  info(): UnitInfo;
  isMarkedForDeletion(): boolean;
  markForDeletion(): void;
  isOverdueDeletion(): boolean;
  delete(displayMessage?: boolean, destroyer?: Player): void;
  tile(): TileRef;
  lastTile(): TileRef;
  move(tile: TileRef): void;
  isActive(): boolean;
  setOwner(owner: Player): void;
  touch(): void;
  hash(): number;
  toUpdate(): UnitUpdate;
  hasTrainStation(): boolean;
  setTrainStation(trainStation: boolean): void;
  wasDestroyedByEnemy(): boolean;
  destroyer(): Player | undefined;

  // Train
  trainType(): TrainType | undefined;
  isLoaded(): boolean | undefined;
  setLoaded(loaded: boolean): void;

  // Targeting
  setTargetTile(cell: TileRef | undefined): void;
  targetTile(): TileRef | undefined;
  targetPlayer(): Player | TerraNullius | undefined;
  setTrajectoryIndex(i: number): void;
  trajectoryIndex(): number;
  trajectory(): TrajectoryTile[];
  setTargetUnit(unit: Unit | undefined): void;
  targetUnit(): Unit | undefined;
  setTargetedBySAM(targeted: boolean): void;
  targetedBySAM(): boolean;
  setReachedTarget(): void;
  reachedTarget(): boolean;
  isTargetable(): boolean;
  setTargetable(targetable: boolean): void;

  // Health
  hasHealth(): boolean;
  warshipState(): WarshipState;
  updateWarshipState(update: Partial<WarshipState>): void;
  transportShipState(): TransportShipState;
  updateTransportShipState(update: Partial<TransportShipState>): void;
  nukeState(): NukeState;
  updateNukeState(update: Partial<NukeState>): void;

  health(): number;
  /** Effective max health, including any warship veterancy bonus. */
  maxHealth(): number;
  modifyHealth(delta: number, attacker?: Player): void;

  // Warship veterancy
  /** Current veterancy level from warshipState (0 for non-warships). */
  veterancy(): number;
  /** Record this warship destroying an enemy unit (drives veterancy gain). */
  recordKill(targetType: UnitType): void;
  /** Record this warship capturing a trade ship (drives veterancy gain). */
  recordTradeCapture(): void;

  // Troops
  setTroops(troops: number): void;
  troops(): number;

  // --- UNIT SPECIFIC ---

  // SAMs & Missile Silos
  launch(): void;
  reloadMissile(): void;
  isInCooldown(): boolean;
  missileTimerQueue(): number[];
  samLauncherState(): SamLauncherState | undefined;

  // Trade Ships
  setSafeFromPirates(): void; // Only for trade ships
  isSafeFromPirates(): boolean; // Only for trade ships

  // Construction phase on structures
  isUnderConstruction(): boolean;
  setUnderConstruction(underConstruction: boolean): void;

  // Upgradable Structures
  level(): number;
  increaseLevel(): void;
  decreaseLevel(destroyer?: Player): void;
}

export interface TerraNullius {
  isPlayer(): false;
  id(): null;
  clientID(): ClientID;
  smallID(): number;
}

export interface Embargo {
  createdAt: Tick;
  isTemporary: boolean;
  target: Player;
}

export interface DisconnectSnapshot {
  currentTick: number;
  teamTiles: number;
  totalLand: number;
  wasAlive: boolean;
}

export interface Player {
  // Basic Info
  smallID(): number;
  info(): PlayerInfo;
  name(): string;
  displayName(): string;
  clanTag(): string | null;
  clientID(): ClientID | null;
  id(): PlayerID;
  type(): PlayerType;
  isPlayer(): this is Player;
  toString(): string;
  isLobbyCreator(): boolean;

  // State & Properties
  isAlive(): boolean;
  isTraitor(): boolean;
  markTraitor(): void;
  // Doomsday Clock (anti-stall): marked when below the rising territory bar.
  inDoomsdayClock(): boolean;
  /** Territory is actively rotting away (the final doomsday phase). */
  isDecaying(): boolean;
  markRotted(): void;
  doomsdayClockTicks(): number;
  enterDoomsdayClock(): void;
  clearDoomsdayClock(): void;
  largestClusterBoundingBox: { min: Cell; max: Cell } | null;
  lastTileChange(): Tick;
  /** Counter bumped on every ownership change of one of this player's tiles (also when its border set can change). */
  tileChangeVersion(): number;

  isDisconnected(): boolean;
  markDisconnected(
    isDisconnected: boolean,
    snapshot?: DisconnectSnapshot,
  ): void;
  disconnectSnapshot(): DisconnectSnapshot | null;
  disconnectedAtTick(): number | null;

  hasSpawned(): boolean;
  setSpawnTile(spawnTile: TileRef): void;
  spawnTile(): TileRef | undefined;

  // Territory
  tiles(): ReadonlyTileSet;
  borderTiles(): ReadonlyTileSet;
  numTilesOwned(): number;
  conquer(tile: TileRef): void;
  relinquish(tile: TileRef): void;

  // Resources & Troops
  gold(): Gold;
  addGold(toAdd: Gold, tile?: TileRef): void;
  removeGold(toRemove: Gold): Gold;
  resources(): StrategicResources;
  resourceConsumption(): StrategicResources;
  addResources(toAdd: StrategicResources): void;
  removeResource(resource: StrategicResource, amount: number): boolean;
  tradeContracts(): readonly TradeContract[];
  addTradeContract(contract: TradeContract): boolean;
  cancelTradeContract(contractID: string): boolean;
  processTradeContracts(): void;
  provideEconomicAid(other: Player, amount: Gold): boolean;
  launchJointProject(other: Player): boolean;
  diplomaticCrises(): readonly DiplomaticCrisis[];
  startDiplomaticCrisis(other: Player): boolean;
  processDiplomaticCrises(): void;
  offerCrisisConcession(issuer: Player): boolean;
  mediateCrisisInvolving(other: Player): boolean;
  stability(): number;
  publicSatisfaction(): number;
  taxPolicy(): TaxPolicy;
  setTaxPolicy(policy: TaxPolicy): void;
  taxIncomeMultiplierPercent(): number;
  updateDomesticPolitics(): void;
  mobilizationTarget(): number;
  setMobilizationTarget(percent: number): void;
  governmentProfile(): GovernmentProfile;
  nationalInterests(): NationalInterests;
  nationalAgenda(): NationalAgenda;
  refreshNationalAgenda(force?: boolean): void;

  // Cumulative trade revenue, surfaced on the live PlayerUpdate so clients can
  // compute per-source gold rates (leaderboard "Ship/Train Trade Gold/min").
  // Mirrors StatsSchemas GOLD_INDEX_TRADE / GOLD_INDEX_TRAIN_* semantics.
  tradeGold(): Gold;
  addTradeGold(toAdd: Gold): void;
  trainGold(): Gold;
  addTrainGold(toAdd: Gold): void;

  // Cumulative piracy revenue (captured trade ships; GOLD_INDEX_STEAL).
  piracyGold(): Gold;
  addPiracyGold(toAdd: Gold): void;

  // Cumulative gold received from ALL sources (workers, trade, trains,
  // piracy, conquest, donations). Incremented inside addGold(); surfaced on
  // the live PlayerUpdate for the leaderboard "Gold Income/min" column.
  goldEarned(): Gold;
  troops(): number;
  setTroops(troops: number): void;
  addTroops(troops: number): void;
  removeTroops(troops: number): number;

  // Units
  // Fixed-arity + array overloads instead of a rest parameter: the rest array
  // would be allocated on every call, and this is one of the hottest calls in
  // the simulation. With no arguments the player's live unit array is
  // returned — do not mutate it; typed queries return a fresh snapshot array.
  units(): Unit[];
  units(types: readonly UnitType[]): Unit[];
  units(type: UnitType, type2?: UnitType, type3?: UnitType): Unit[];
  unitCount(type: UnitType): number;
  unitsConstructed(type: UnitType): number;
  unitsOwned(type: UnitType): number;
  buildableUnits(
    tile: TileRef | null,
    units?: readonly PlayerBuildableUnitType[],
  ): BuildableUnit[];
  canBuild(
    type: UnitType,
    targetTile: TileRef,
    validTiles?: TileRef[] | null,
  ): TileRef | false;
  buildUnit<T extends UnitType>(
    type: T,
    spawnTile: TileRef,
    params: UnitParams<T>,
  ): Unit;

  // Returns the existing unit that can be upgraded,
  // or false if it cannot be upgraded.
  // New units of the same type can upgrade existing units.
  // e.g. if a place a new city here, can it upgrade an existing city?
  findUnitToUpgrade(type: UnitType, targetTile: TileRef): Unit | false;
  canUpgradeUnit(unit: Unit): boolean;
  upgradeUnit(unit: Unit): void;
  captureUnit(unit: Unit): void;

  // Relations & Diplomacy
  nearby(): (Player | TerraNullius)[];
  sharesBorderWith(other: Player | TerraNullius): boolean;
  relation(other: Player): Relation;
  relationScore(other: Player): number;
  allRelationsSorted(): { player: Player; relation: Relation }[];
  updateRelation(other: Player, delta: number): void;
  trust(other: Player): number;
  changeTrust(other: Player, delta: number): void;
  perceivedThreat(other: Player, sharesBorder?: boolean): number;
  rememberDiplomaticEvent(
    other: Player,
    type: DiplomaticMemoryType,
    opinionImpact: number,
    trustImpact: number,
    options?: DiplomaticMemoryOptions,
  ): void;
  diplomaticMemories(): readonly DiplomaticMemory[];
  grievanceScore(other: Player): number;
  decayRelations(): void;
  casusBelliAgainst(other: Player): CasusBelli | null;
  grantCasusBelli(
    other: Player,
    type: CasusBelliType,
    durationTicks?: number,
  ): void;
  consumeCasusBelli(other: Player): CasusBelli | null;
  isWarAuthorizedAgainst(other: Player): boolean;
  authorizeWarAgainst(
    other: Player,
    durationTicks?: number,
    warGoal?: CasusBelliType | null,
  ): void;
  warGoalAgainst(other: Player): CasusBelliType | null;
  warGoalRegionAgainst(other: Player): number | null;
  setWarGoalRegionAgainst(other: Player, regionID: number): void;
  clearWarGoalRegionAgainst(other: Player): void;
  endWarAgainst(other: Player): void;
  concludePeaceWith(other: Player, truceTicks?: number): void;
  truceWith(other: Player): Tick | null;
  nonAggressionPactWith(other: Player): Tick | null;
  setNonAggressionPact(other: Player, durationTicks?: number): void;
  breakNonAggressionPact(other: Player): void;
  tradeAgreementWith(other: Player): Tick | null;
  setTradeAgreement(other: Player, durationTicks?: number): void;
  guarantees(other: Player): boolean;
  setGuarantee(other: Player, enabled: boolean): void;
  threat(): number;
  reputation(): number;
  changeThreat(delta: number): void;
  changeReputation(delta: number): void;
  isOnSameTeam(other: Player): boolean;
  // Either allied or on same team.
  isFriendly(other: Player, treatAFKFriendly?: boolean): boolean;
  team(): Team | null;
  incomingAllianceRequests(): AllianceRequest[];
  outgoingAllianceRequests(): AllianceRequest[];
  alliances(): MutableAlliance[];
  expiredAlliances(): Alliance[];
  allies(): Player[];
  isAlliedWith(other: Player): boolean;
  allianceWith(other: Player): MutableAlliance | null;
  allianceInfo(other: Player): AllianceInfo | null;
  canSendAllianceRequest(other: Player): boolean;
  breakAlliance(alliance: Alliance): void;
  removeAllAlliances(): void;
  createAllianceRequest(recipient: Player): AllianceRequest | null;
  betrayals(): number;

  // Targeting
  canTarget(other: Player): boolean;
  target(other: Player): void;
  targets(): Player[];
  transitiveTargets(): Player[];

  // Communication
  canSendEmoji(recipient: Player | typeof AllPlayers): boolean;
  outgoingEmojis(): EmojiMessage[];
  sendEmoji(recipient: Player | typeof AllPlayers, emoji: string): void;
  canSendQuickChat(recipient: Player): boolean;
  recordQuickChat(recipient: Player): void;

  // Donation
  canDonateGold(recipient: Player): boolean;
  canDonateTroops(recipient: Player): boolean;
  donateTroops(recipient: Player, troops: number): boolean;
  donateGold(recipient: Player, gold: Gold): boolean;
  canDeleteUnit(): boolean;
  recordDeleteUnit(): void;
  canEmbargoAll(): boolean;
  recordEmbargoAll(): void;

  // Embargo
  hasEmbargoAgainst(other: Player): boolean;
  tradingPartners(): Player[];
  addEmbargo(other: Player, isTemporary: boolean): void;
  getEmbargoes(): Embargo[];
  stopEmbargo(other: Player): void;
  endTemporaryEmbargo(other: Player): void;
  canTrade(other: Player): boolean;

  // Attacking.
  canAttack(tile: TileRef): boolean;
  canAttackPlayer(player: Player, treatAFKFriendly?: boolean): boolean;
  isImmune(): boolean;

  createAttack(
    target: Player | TerraNullius,
    troops: number,
    sourceTile: TileRef | null,
    border: Set<number>,
  ): Attack;
  outgoingAttacks(): Attack[];
  incomingAttacks(): Attack[];
  orderRetreat(attackID: string): void;
  executeRetreat(attackID: string): void;

  // Misc
  toUpdate(
    statsOut?: number[],
    attackTroopsOut?: number[],
  ): PlayerUpdate | null;
  playerProfile(): PlayerProfile;
  // WARNING: this operation is expensive.
  bestTransportShipSpawn(tile: TileRef): TileRef | false;
}

export interface StrategicResources {
  food: number;
  materials: number;
  fuel: number;
}

export type TaxPolicy = "very_low" | "low" | "normal" | "high" | "very_high";

export interface HistoricalRegion {
  id: number;
  name: string;
  founderID: PlayerID;
  tileCount: number;
  representativeTile: TileRef;
  resources: StrategicResources;
}

export interface Game extends GameMap {
  // Map & Dimensions
  isOnMap(cell: Cell): boolean;
  width(): number;
  height(): number;
  map(): GameMap;
  miniMap(): GameMap;
  historicalRegions(): readonly HistoricalRegion[];
  historicalRegionIds(): Uint32Array;
  historicalRegionAt(tile: TileRef): HistoricalRegion | null;
  historicalRegionOwnedTiles(regionID: number, player: Player): number;
  historicalRegionControl(
    regionID: number,
  ): { player: Player; tiles: number; share: number }[];
  resourceProduction(player: Player): StrategicResources;
  territoryVersion(): number;
  forEachTile(fn: (tile: TileRef) => void): void;
  // Zero-allocation neighbor iteration (cardinal only), in the same N, S, W, E
  // order as neighbors().
  forEachNeighbor(tile: TileRef, callback: (neighbor: TileRef) => void): void;
  // Writes the cardinal neighbors of ref into out (same N, S, W, E order as
  // neighbors()) and returns the count. Reuse out across calls to avoid
  // allocation.
  neighbors4(ref: TileRef, out: TileRef[]): number;
  neighbors8(ref: TileRef, out: TileRef[]): number;
  // Zero-allocation neighbor iteration for performance-critical cluster calculation
  // Alternative to neighborsWithDiag() that returns arrays
  // Avoids creating intermediate arrays and uses a callback for better performance
  forEachNeighborWithDiag(
    tile: TileRef,
    callback: (neighbor: TileRef) => void,
  ): void;

  // Player Management
  player(id: PlayerID): Player;
  players(): Player[];
  allPlayers(): Player[];
  playerByClientID(id: ClientID): Player | null;
  playerBySmallID(id: number): Player | TerraNullius;
  hasPlayer(id: PlayerID): boolean;
  addPlayer(playerInfo: PlayerInfo): Player;
  terraNullius(): TerraNullius;
  owner(ref: TileRef): Player | TerraNullius;

  teams(): Team[];
  teamTilesOwned(team: Team): number;
  totalLandTiles(): number;
  teamSpawnArea(team: Team): SpawnArea | undefined;

  // Alliances
  expireAlliance(alliance: Alliance): void;

  // Immunity timer
  isSpawnImmunityActive(): boolean;
  isNationSpawnImmunityActive(): boolean;
  elapsedGameSeconds(): number;

  // Game State
  ticks(): Tick;
  ticksSinceStart(): Tick;
  inSpawnPhase(): boolean;
  endSpawnPhase(): void;
  executeNextTick(): GameUpdates;
  executePausedActions(executions: Execution[]): GameUpdates;
  executions(): Execution[];
  drainPackedTileUpdates(): Uint32Array;
  recordMotionPlan(record: MotionPlanRecord): void;
  drainPackedMotionPlans(): Uint32Array | null;
  drainPackedPlayerUpdates(): Float64Array | null;
  drainPackedAttackUpdates(): Float64Array | null;
  // null ends the game with no winner (a cancelled match, e.g. a ranked game
  // that didn't fill): the record is archived winnerless and never ranked.
  setWinner(
    winner: Player | Team | null,
    allPlayersStats: AllPlayersStats,
  ): void;
  getWinner(): Player | Team | null;
  config(): Config;
  isPaused(): boolean;
  setPaused(paused: boolean): void;

  // Units
  unit(id: number): Unit | undefined;
  // See Player.units() for why this is not a rest parameter.
  units(): Unit[];
  units(types: readonly UnitType[]): Unit[];
  units(type: UnitType, type2?: UnitType, type3?: UnitType): Unit[];
  unitCount(type: UnitType): number;
  unitInfo(type: UnitType): UnitInfo;
  hasUnitNearby(
    tile: TileRef,
    searchRange: number,
    type: UnitType,
    playerId?: PlayerID,
    includeUnderConstruction?: boolean,
  ): boolean;
  anyUnitNearby(
    tile: TileRef,
    searchRange: number,
    types: readonly UnitType[],
    predicate: (unit: Unit) => boolean,
    playerId?: PlayerID,
    includeUnderConstruction?: boolean,
  ): boolean;
  nearbyUnits(
    tile: TileRef,
    searchRange: number,
    types: UnitType | readonly UnitType[],
    predicate?: UnitPredicate,
    includeUnderConstruction?: boolean,
  ): Array<{ unit: Unit; distSquared: number }>;

  addExecution(...exec: Execution[]): void;
  displayMessage(
    message: string,
    type: MessageType,
    playerID: PlayerID | null,
    goldAmount?: bigint,
    params?: Record<string, string | number>,
    unitID?: number,
    focusPlayerID?: PlayerID,
  ): void;
  displayIncomingUnit(
    unitID: number,
    message: string,
    type: MessageType,
    playerID: PlayerID | null,
  ): void;

  displayChat(
    message: string,
    category: string,
    target: PlayerID | undefined,
    playerID: PlayerID | null,
    isFrom: boolean,
    recipient: string,
  ): void;

  // Nations
  nations(): Nation[];

  numTilesWithFallout(): number;
  stats(): Stats;

  addUpdate(update: GameUpdate): void;
  railNetwork(): RailNetwork;
  conquerPlayer(conqueror: Player, conquered: Player): void;
  miniWaterHPA(): PathFinder<number> | null;
  miniWaterGraph(): AbstractGraph | null;
  getWaterComponent(tile: TileRef): number | null;
  hasWaterComponent(tile: TileRef, component: number): boolean;
  /**
   * Returns the approximate number of water tiles in the component
   * containing `tile`, or null if the tile has no water component. Useful for
   * filtering tiny water bodies (e.g. preventing AI port placement on ponds).
   */
  getWaterComponentSize(tile: TileRef): number | null;
  /**
   * Returns the set of water components that `player` shares with at least one
   * valid trade partner (cached). Used by nation AI for port-placement
   * heuristics. `null` means no usable water body for ports.
   */
  sharedWaterComponents(player: Player): Set<number> | null;
  /** Incremented each time the water navigation graph is rebuilt (e.g. after nuke terrain change). */
  waterGraphVersion(): number;

  /** Queue a land tile for conversion to water (batched every few ticks). Tile must be unowned. */
  queueWaterConversion(tile: TileRef): void;

  /** Queue a tile that was inside a nuke blast radius (for nukeable layer destruction). */
  queueNukeImpact(tile: TileRef): void;

  /** Drain all tiles from nuke impacts this tick. Called once per tick. */
  drainNukeImpacts(): TileRef[];
}

export interface PlayerActions {
  canAttack: boolean;
  buildableUnits: BuildableUnit[];
  canSendEmojiAllPlayers: boolean;
  canEmbargoAll?: boolean;
  interaction?: PlayerInteraction;
  /** Diplomacy+ V1.16: immutable historical region under the inspected tile. */
  historicalRegionID?: number;
}

export interface BuildableUnit {
  canBuild: TileRef | false;
  // unit id of the existing unit that can be upgraded, or false if it cannot be upgraded.
  canUpgrade: number | false;
  type: PlayerBuildableUnitType;
  cost: Gold;
  // Cumulative cost of upgrading 1..MAX_UPGRADE_AMOUNT times (upgrade costs
  // escalate per level, so a bulk total is NOT cost * amount). Only set when
  // canUpgrade is not false.
  upgradeCosts?: Gold[];
  overlappingRailroads: TileRef[];
  ghostRailPaths: TileRef[][];
}

// Total price of buying `amount` of a buildable in one intent. Upgrades use
// the escalating totals from core; flat-cost units (nukes) scale linearly.
export function bulkCost(bu: BuildableUnit, amount: number): Gold {
  return bu.upgradeCosts?.[amount - 1] ?? bu.cost * BigInt(amount);
}

// Largest amount (up to MAX_UPGRADE_AMOUNT) whose bulk total fits in `gold`.
// 0 when not even a single purchase is affordable.
export function maxBulkAmount(bu: BuildableUnit, gold: Gold): number {
  let max = 0;
  for (let n = 1; n <= MAX_UPGRADE_AMOUNT; n++) {
    // Never price upgrades past the shipped totals — beyond the array,
    // bulkCost would silently fall back to linear pricing.
    if (bu.upgradeCosts !== undefined && n > bu.upgradeCosts.length) {
      break;
    }
    if (bulkCost(bu, n) > gold) {
      break;
    }
    max = n;
  }
  return max;
}

// Fixed mid-ladder steps for the bulk menus. Bombs come in smaller batches
// than structure upgrades — x2 is the standard play against a single SAM.
export const NUKE_BULK_STEPS: readonly number[] = [2, 5];
export const STRUCTURE_BULK_STEPS: readonly number[] = [5, 10];

export interface PlayerProfile {
  relations: Record<number, Relation>;
  alliances: number[];
}

export interface PlayerBorderTiles {
  borderTiles: ReadonlySet<TileRef>;
}

export interface AllianceInfo {
  expiresAt: Tick;
  inExtensionWindow: boolean;
  myPlayerAgreedToExtend: boolean;
  otherAgreedToExtend: boolean;
  canExtend: boolean;
}

export interface PlayerInteraction {
  sharedBorder: boolean;
  canSendEmoji: boolean;
  canSendAllianceRequest: boolean;
  canBreakAlliance: boolean;
  canTarget: boolean;
  canDonateGold: boolean;
  canDonateTroops: boolean;
  canEmbargo: boolean;
  allianceInfo?: AllianceInfo;
}

export interface EmojiMessage {
  message: string;
  senderID: number;
  recipientID: number | typeof AllPlayers;
  createdAt: Tick;
}

export enum MessageType {
  ATTACK_FAILED,
  ATTACK_CANCELLED,
  ATTACK_REQUEST,
  CONQUERED_PLAYER,
  MIRV_INBOUND,
  NUKE_INBOUND,
  NUKE_DETONATED,
  HYDROGEN_BOMB_INBOUND,
  NAVAL_INVASION_INBOUND,
  SAM_MISS,
  SAM_HIT,
  CAPTURED_ENEMY_UNIT,
  UNIT_DESTROYED,
  ALLIANCE_ACCEPTED,
  ALLIANCE_REJECTED,
  ALLIANCE_REQUEST,
  ALLIANCE_BROKEN,
  ALLIANCE_EXPIRED,
  DONATION_SENT,
  DONATION_RECEIVED,
  CHAT,
  RENEW_ALLIANCE,
}

// Message categories used for filtering events in the EventsDisplay
export enum MessageCategory {
  ATTACK = "ATTACK",
  NUKE = "NUKE",
  ALLIANCE = "ALLIANCE",
  TRADE = "TRADE",
  CHAT = "CHAT",
}

// Ensures that all message types are included in a category
export const MESSAGE_TYPE_CATEGORIES: Record<MessageType, MessageCategory> = {
  [MessageType.ATTACK_FAILED]: MessageCategory.ATTACK,
  [MessageType.ATTACK_CANCELLED]: MessageCategory.ATTACK,
  [MessageType.ATTACK_REQUEST]: MessageCategory.ATTACK,
  [MessageType.CONQUERED_PLAYER]: MessageCategory.ATTACK,
  [MessageType.MIRV_INBOUND]: MessageCategory.NUKE,
  [MessageType.NUKE_INBOUND]: MessageCategory.NUKE,
  [MessageType.NUKE_DETONATED]: MessageCategory.NUKE,
  [MessageType.HYDROGEN_BOMB_INBOUND]: MessageCategory.NUKE,
  [MessageType.NAVAL_INVASION_INBOUND]: MessageCategory.ATTACK,
  [MessageType.SAM_MISS]: MessageCategory.ATTACK,
  [MessageType.SAM_HIT]: MessageCategory.ATTACK,
  [MessageType.CAPTURED_ENEMY_UNIT]: MessageCategory.ATTACK,
  [MessageType.UNIT_DESTROYED]: MessageCategory.ATTACK,
  [MessageType.ALLIANCE_ACCEPTED]: MessageCategory.ALLIANCE,
  [MessageType.ALLIANCE_REJECTED]: MessageCategory.ALLIANCE,
  [MessageType.ALLIANCE_REQUEST]: MessageCategory.ALLIANCE,
  [MessageType.ALLIANCE_BROKEN]: MessageCategory.ALLIANCE,
  [MessageType.ALLIANCE_EXPIRED]: MessageCategory.ALLIANCE,
  [MessageType.RENEW_ALLIANCE]: MessageCategory.ALLIANCE,
  [MessageType.DONATION_SENT]: MessageCategory.TRADE,
  [MessageType.DONATION_RECEIVED]: MessageCategory.TRADE,
  [MessageType.CHAT]: MessageCategory.CHAT,
} as const;

/**
 * Get the category of a message type
 */
export function getMessageCategory(messageType: MessageType): MessageCategory {
  return MESSAGE_TYPE_CATEGORIES[messageType];
}

export interface NameViewData {
  x: number;
  y: number;
  size: number;
}
