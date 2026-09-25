import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { DiplomacyPlusExecution } from "../src/core/execution/DiplomacyPlusExecution";
import { PauseExecution } from "../src/core/execution/PauseExecution";
import { AllianceRequestExecution } from "../src/core/execution/alliance/AllianceRequestExecution";
import { Execution, Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game, actor: Player, target: Player;
beforeEach(async () => {
  game = await setup("plains", {}, [new PlayerInfo("A", PlayerType.Human, "a", "a"), new PlayerInfo("B", PlayerType.Nation, null, "b")]);
  actor = game.player("a"); target = game.player("b");
  actor.conquer(game.ref(50, 50)); target.conquer(game.ref(50, 51)); target.conquer(game.ref(50, 52));
  actor.addTroops(1000);
  vi.spyOn(game, "ticksSinceStart").mockReturnValue(300);
});
afterEach(() => vi.restoreAllMocks());

describe("active pause", () => {
  it("publishes pause and resume without advancing simulation or background executions", () => {
    const background: Execution = { init: vi.fn(), tick: vi.fn(), isActive: () => true, activeDuringSpawnPhase: () => false };
    game.addExecution(background); game.executeNextTick();
    const ticks = game.ticks();
    game.executePausedActions([new PauseExecution(actor, true)]);
    expect(game.isPaused()).toBe(true);
    game.executePausedActions([new PauseExecution(actor, false)]);
    expect(game.isPaused()).toBe(false);
    expect(game.ticks()).toBe(ticks);
    expect(background.tick).not.toHaveBeenCalled();
  });

  it("registers a NAP request now but resolves it only on the next simulation tick", () => {
    const ticks = game.ticks();
    const request = new DiplomacyPlusExecution(actor, target.id(), "offer_nap");
    game.executePausedActions([request]);
    expect(game.executions()).toContain(request);
    expect(actor.nonAggressionPactWith(target)).toBeNull();
    expect(game.ticks()).toBe(ticks);
    game.executeNextTick();
    expect(actor.nonAggressionPactWith(target)).not.toBeNull();
    expect(request.isActive()).toBe(false);
  });

  it("does not duplicate pending requests or repeated guarantee rewards", () => {
    game.executePausedActions([new DiplomacyPlusExecution(actor, target.id(), "offer_nap")]);
    game.executePausedActions([new DiplomacyPlusExecution(actor, target.id(), "offer_nap")]);
    expect(game.executions().filter(e => e instanceof DiplomacyPlusExecution)).toHaveLength(1);
    game.executePausedActions([new DiplomacyPlusExecution(actor, target.id(), "guarantee")]);
    expect(actor.guarantees(target)).toBe(true);
    const relation = actor.relation(target);
    game.executePausedActions([new DiplomacyPlusExecution(actor, target.id(), "guarantee")]);
    expect(actor.relation(target)).toBe(relation);
  });

  it("declares war and commits the attack without capturing territory", () => {
    const ticks = game.ticks(), tiles = target.numTilesOwned();
    const attack = new AttackExecution(100, actor, target.id());
    game.executePausedActions([attack]);
    expect(actor.isWarAuthorizedAgainst(target)).toBe(true);
    expect(actor.outgoingAttacks()).toHaveLength(1);
    expect(target.numTilesOwned()).toBe(tiles);
    expect(game.ticks()).toBe(ticks);
    game.executePausedActions([new DiplomacyPlusExecution(actor, target.id(), "guarantee")]);
    expect(target.numTilesOwned()).toBe(tiles);
    expect(game.ticks()).toBe(ticks);
  });

  it("still rejects attacks under truce while paused", () => {
    actor.concludePeaceWith(target);
    const troops = actor.troops();
    game.executePausedActions([new AttackExecution(100, actor, target.id())]);
    expect(actor.outgoingAttacks()).toHaveLength(0);
    expect(actor.troops()).toBe(troops);
    expect(actor.isWarAuthorizedAgainst(target)).toBe(false);
  });

  it("publishes an alliance request without running the nation's response", () => {
    game.executePausedActions([new AllianceRequestExecution(actor, target.id())]);
    expect(actor.outgoingAllianceRequests()).toHaveLength(1);
    expect(actor.isAlliedWith(target)).toBe(false);
  });
});

it("keeps archived turn indices separate from simulation ticks", async () => {
  const { GameRunner } = await import("../src/core/GameRunner");
  const { Executor } = await import("../src/core/execution/ExecutionManager");
  const { GameUpdateType } = await import("../src/core/game/GameUpdates");
  const callback = vi.fn();
  const runner = new GameRunner(game, new Executor(game, "pause-test", "a"), callback);
  runner.addTurn({ turnNumber: 0, actionsOnly: true, intents: [{ type: "toggle_pause", paused: true, clientID: "a" }] });
  runner.addTurn({ turnNumber: 1, actionsOnly: true, intents: [{ type: "toggle_pause", paused: false, clientID: "a" }] });
  runner.addTurn({ turnNumber: 2, intents: [] });
  expect(runner.executeNextTick()).toBe(true);
  expect(game.ticks()).toBe(0);
  expect(runner.executeNextTick()).toBe(true);
  expect(game.ticks()).toBe(0);
  expect(runner.executeNextTick()).toBe(true);
  expect(game.ticks()).toBe(1);
  const update = callback.mock.calls[callback.mock.calls.length - 1][0];
  expect(update.updates[GameUpdateType.Hash][0].turnNumber).toBe(2);
});
