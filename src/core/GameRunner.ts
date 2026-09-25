import { placeName, placeSpawnName } from "../client/hud/NameBoxCalculator";
import { Config } from "./configuration/Config";
import { DoomsdayClockExecution } from "./execution/DoomsdayClockExecution";
import { Executor } from "./execution/ExecutionManager";
import { RecomputeRailClusterExecution } from "./execution/RecomputeRailClusterExecution";
import { SpawnTimerExecution } from "./execution/SpawnTimerExecution";
import { WinCheckExecution } from "./execution/WinCheckExecution";
import {
  AllPlayers,
  BuildableUnit,
  Game,
  GameType,
  GameUpdates,
  NameViewData,
  Player,
  PlayerActions,
  PlayerBorderTiles,
  PlayerBuildableUnitType,
  PlayerID,
  PlayerInfo,
  PlayerProfile,
  PlayerType,
  WORLD_FORMATION_END_TICK,
  WORLD_FORMATION_UNLOCK_TICK,
  UnitType,
} from "./game/Game";
import { createGame } from "./game/GameImpl";
import { TileRef } from "./game/GameMap";
import { GameMapLoader } from "./game/GameMapLoader";
import { ErrorUpdate, GameUpdateType, GameUpdateViewData } from "./game/GameUpdates";
import { createNationsForGame } from "./game/NationCreation";
import { loadTerrainMap as loadGameMap } from "./game/TerrainMapLoader";
import { PseudoRandom } from "./PseudoRandom";
import { ClientID, GameStartInfo, Turn } from "./Schemas";
import { simpleHash } from "./Util";

export async function createGameRunner(
  gameStart: GameStartInfo,
  clientID: ClientID | undefined,
  mapLoader: GameMapLoader,
  callBack: (gu: GameUpdateViewData | ErrorUpdate) => void,
): Promise<GameRunner> {
  const config = new Config(gameStart.config, null, false, gameStart.listed);
  const gameMap = await loadGameMap(
    gameStart.config.gameMap,
    gameStart.config.gameMapSize,
    mapLoader,
    false, // Worker never renders layers — skip image loading to save memory.
  );
  const random = new PseudoRandom(simpleHash(gameStart.gameID));

  const humans = gameStart.players.map((p) => {
    return new PlayerInfo(
      p.username,
      PlayerType.Human,
      p.clientID,
      random.nextID(),
      p.isLobbyCreator ?? false,
      p.clanTag,
      p.friends ?? [],
      p.teamIndex ?? null,
    );
  });

  const nations = createNationsForGame(
    gameStart,
    gameMap.nations,
    gameMap.additionalNations,
    humans.length,
    random,
  );

  const game: Game = createGame(
    humans,
    nations,
    gameMap.gameMap,
    gameMap.miniGameMap,
    config,
    gameMap.teamGameSpawnAreas,
  );

  const gr = new GameRunner(
    game,
    new Executor(
      game,
      gameStart.gameID,
      clientID,
      gameStart.tribes?.map((t) => t.name),
    ),
    callBack,
  );
  gr.init();
  return gr;
}

export class GameRunner {
  private turns: Turn[] = [];
  private currTurn = 0;
  private isExecuting = false;
  private historicalRegionsSent = false;
  private lastHistoricalRegionTerritoryVersion = -1;

  private playerViewData: Record<PlayerID, NameViewData> = {};

  constructor(
    public game: Game,
    private execManager: Executor,
    private callBack: (gu: GameUpdateViewData | ErrorUpdate) => void,
  ) {}

  init() {
    if (this.game.config().gameConfig().gameType !== GameType.Singleplayer) {
      this.game.addExecution(new SpawnTimerExecution());
    }
    // Everyone spawns normally. Nations exist from tick zero, but their territorial
    // expansion is locked during World Formation; tribes alone fill Terra Nullius.
    if (this.game.config().spawnNations()) {
      this.game.addExecution(...this.execManager.nationExecutions());
    }
    if (this.game.config().isRandomSpawn()) {
      this.game.addExecution(...this.execManager.spawnPlayers());
    }
    if (this.game.config().bots() > 0) {
      // Diplomacy+ regional formation: solo worlds start denser so the
      // eventual historical regions are smaller and more numerous.
      const configuredTribes = this.game.config().bots();
      const tribeCount =
        this.game.config().gameConfig().gameType === GameType.Singleplayer
          ? Math.min(configuredTribes * 2, 800)
          : configuredTribes;
      this.game.addExecution(...this.execManager.spawnTribes(tribeCount));
    }
    this.game.addExecution(new WinCheckExecution());
    if (this.game.config().doomsdayClockConfig().enabled) {
      this.game.addExecution(new DoomsdayClockExecution());
    }
    if (!this.game.config().isUnitDisabled(UnitType.Factory)) {
      this.game.addExecution(
        new RecomputeRailClusterExecution(this.game.railNetwork()),
      );
    }
  }

  public addTurn(turn: Turn): void {
    this.turns.push(turn);
  }

  public executeNextTick(pendingTurns?: number): boolean {
    if (this.isExecuting) {
      return false;
    }
    if (this.currTurn >= this.turns.length) {
      return false;
    }
    this.isExecuting = true;

    const turn = this.turns[this.currTurn];
    const executions = this.execManager.createExecs(turn);
    this.currTurn++;

    const wasInSpawnPhase = this.game.inSpawnPhase();
    let updates: GameUpdates;
    let tickExecutionDuration: number;

    try {
      const startTime = performance.now();
      if (turn.actionsOnly) {
        updates = this.game.executePausedActions(executions);
      } else {
        this.game.addExecution(...executions);
        updates = this.game.executeNextTick();
      }
      for (const hash of updates[GameUpdateType.Hash]) {
        hash.turnNumber = this.currTurn - 1;
      }
      const endTime = performance.now();
      tickExecutionDuration = endTime - startTime;
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error("Game tick error:", error.message);
        this.callBack({
          errMsg: error.message,
          stack: error.stack,
        } as ErrorUpdate);
      } else {
        console.error("Game tick error:", error);
      }
      this.isExecuting = false;
      return false;
    }

    // Track whether placements were recomputed this tick — the record is
    // only attached to the update when it could have changed, so the main
    // thread doesn't structured-clone an identical ~all-players record on
    // every other tick.
    let viewDataChanged = false;
    if (this.game.inSpawnPhase()) {
      for (const p of this.game.players()) {
        if (p.type() !== PlayerType.Human && p.type() !== PlayerType.Nation) {
          continue;
        }
        if (p.spawnTile() === undefined) continue;
        this.playerViewData[p.id()] = placeSpawnName(this.game, p);
        viewDataChanged = true;
      }
    }

    const spawnJustEnded = wasInSpawnPhase && !this.game.inSpawnPhase();
    if (
      spawnJustEnded ||
      this.game.ticks() < 3 ||
      this.game.ticks() % 30 === 0
    ) {
      for (const p of this.game.players()) {
        this.playerViewData[p.id()] = placeName(this.game, p);
      }
      viewDataChanged = true;
    }

    const packedTileUpdates = this.game.drainPackedTileUpdates();
    const packedMotionPlans = this.game.drainPackedMotionPlans();
    const packedPlayerUpdates = this.game.drainPackedPlayerUpdates();
    const packedAttackUpdates = this.game.drainPackedAttackUpdates();
    const nukeImpactTiles = this.game.drainNukeImpacts();
    const packedNukeImpacts =
      nukeImpactTiles.length > 0 ? new Uint32Array(nukeImpactTiles) : undefined;

    // Diplomacy+ V1.16: boundaries are still transported only once as the
    // compact sparse tile list. Region summaries are lightweight and refresh
    // at most once/second after territorial changes so country/region dossiers
    // can show current control without a full tile-to-region texture.
    const regionsReady =
      this.game.ticksSinceStart() >= WORLD_FORMATION_UNLOCK_TICK &&
      this.game.historicalRegions().length > 0;
    const territoryVersion = this.game.territoryVersion();
    const shouldSendHistoricalRegions =
      regionsReady &&
      (!this.historicalRegionsSent ||
        (this.game.ticks() % 10 === 0 &&
          territoryVersion !== this.lastHistoricalRegionTerritoryVersion));
    const historicalRegions = shouldSendHistoricalRegions
      ? this.game.historicalRegions().filter((r) => r.tileCount >= 8).map((r) => {
          const control = this.game.historicalRegionControl(r.id);
          const dominant = control[0];
          return {
            id: r.id,
            name: r.name,
            founderID: r.founderID,
            tileCount: r.tileCount,
            representativeTile: r.representativeTile,
            resources: { ...r.resources },
            dominantOwnerID: dominant?.player.id(),
            dominantShare: dominant?.share,
            controllers: control.map((c) => ({
              playerID: c.player.id(),
              tiles: c.tiles,
              share: c.share,
            })),
          };
        })
      : undefined;
    if (shouldSendHistoricalRegions) {
      this.lastHistoricalRegionTerritoryVersion = territoryVersion;
    }

    let historicalRegionBoundaryTiles: Uint32Array | undefined;
    if (regionsReady && !this.historicalRegionsSent) {
      const ids = this.game.historicalRegionIds();
      const boundary: number[] = [];
      const w = this.game.width(), h = this.game.height();
      for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
        const tile=y*w+x, id=ids[tile];
        if (id===0) continue;
        if ((x>0&&ids[tile-1]!==id)||(x+1<w&&ids[tile+1]!==id)||
            (y>0&&ids[tile-w]!==id)||(y+1<h&&ids[tile+w]!==id)) boundary.push(tile);
      }
      historicalRegionBoundaryTiles=new Uint32Array(boundary);
      this.historicalRegionsSent=true;
      console.log(`[Diplomacy+] compact regional boundary: ${boundary.length} tiles`);
    }
    this.callBack({
      tick: this.game.ticks(),
      ...(historicalRegions ? { historicalRegions } : {}),
      ...(historicalRegionBoundaryTiles ? { historicalRegionBoundaryTiles } : {}),
      packedTileUpdates,
      ...(packedMotionPlans ? { packedMotionPlans } : {}),
      ...(packedPlayerUpdates ? { packedPlayerUpdates } : {}),
      ...(packedAttackUpdates ? { packedAttackUpdates } : {}),
      ...(packedNukeImpacts ? { packedNukeImpacts } : {}),
      updates: updates,
      ...(viewDataChanged ? { playerNameViewData: this.playerViewData } : {}),
      tickExecutionDuration: tickExecutionDuration,
      pendingTurns: pendingTurns ?? 0,
    });
    this.isExecuting = false;
    return true;
  }

  public pendingTurns(): number {
    return Math.max(0, this.turns.length - this.currTurn);
  }

  public playerBuildables(
    playerID: PlayerID,
    x?: number,
    y?: number,
    units?: readonly PlayerBuildableUnitType[],
  ): BuildableUnit[] {
    const player = this.game.player(playerID);
    const tile =
      x !== undefined && y !== undefined ? this.game.ref(x, y) : null;
    return player.buildableUnits(tile, units);
  }

  public playerActions(
    playerID: PlayerID,
    x?: number,
    y?: number,
    units?: readonly PlayerBuildableUnitType[] | null,
  ): PlayerActions {
    const player = this.game.player(playerID);
    const tile =
      x !== undefined && y !== undefined ? this.game.ref(x, y) : null;
    const actions = {
      canAttack: tile !== null && player.canAttack(tile),
      buildableUnits: units === null ? [] : player.buildableUnits(tile, units),
      canSendEmojiAllPlayers: player.canSendEmoji(AllPlayers),
      canEmbargoAll: player.canEmbargoAll(),
      historicalRegionID:
        tile === null ? undefined : this.game.historicalRegionAt(tile)?.id,
    } as PlayerActions;

    if (tile !== null && this.game.hasOwner(tile)) {
      const other = this.game.owner(tile) as Player;
      actions.interaction = {
        sharedBorder: player.sharesBorderWith(other),
        canSendEmoji: player.canSendEmoji(other),
        canTarget: player.canTarget(other),
        canSendAllianceRequest: player.canSendAllianceRequest(other),
        canBreakAlliance: player.isAlliedWith(other),
        canDonateGold: player.canDonateGold(other),
        canDonateTroops: player.canDonateTroops(other),
        canEmbargo: !player.hasEmbargoAgainst(other),
        allianceInfo: player.allianceInfo(other) ?? undefined,
      };
    }

    return actions;
  }

  public playerProfile(playerID: number): PlayerProfile {
    const player = this.game.playerBySmallID(playerID);
    if (!player.isPlayer()) {
      throw new Error(`player with id ${playerID} not found`);
    }
    return player.playerProfile();
  }
  public playerBorderTiles(playerID: PlayerID): PlayerBorderTiles {
    const player = this.game.player(playerID);
    if (!player.isPlayer()) {
      throw new Error(`player with id ${playerID} not found`);
    }
    return {
      // Copy into a plain Set: this result crosses the worker boundary via
      // structured clone, which TileSet does not survive.
      borderTiles: new Set(player.borderTiles()),
    } as PlayerBorderTiles;
  }

  public attackClusteredPositions(
    playerID: number,
    attackID?: string,
  ): { id: string; positions: { x: number; y: number }[] }[] {
    const player = this.game.playerBySmallID(playerID);
    if (!player.isPlayer())
      throw new Error(`player with id ${playerID} not found`);
    const all = [...player.outgoingAttacks(), ...player.incomingAttacks()];
    const attacks = attackID ? all.filter((a) => a.id() === attackID) : all;

    return attacks.map((a) => ({
      id: a.id(),
      positions: a.clusteredPositions().map((tile) => ({
        x: this.game.map().x(tile),
        y: this.game.map().y(tile),
      })),
    }));
  }

  public bestTransportShipSpawn(
    playerID: PlayerID,
    targetTile: TileRef,
  ): TileRef | false {
    const player = this.game.player(playerID);
    if (!player.isPlayer()) {
      throw new Error(`player with id ${playerID} not found`);
    }
    return player.bestTransportShipSpawn(targetTile);
  }
}
