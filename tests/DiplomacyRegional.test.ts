import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import {
  CasusBelliType,
  Game,
  HistoricalRegion,
  Player,
  PlayerInfo,
  PlayerType,
} from "../src/core/game/Game";
import { diffPlayerUpdate } from "../src/core/game/GameUpdateUtils";
import { setup } from "./util/Setup";
import { makePlayerUpdate } from "./util/viewStubs";

let game: Game;
let attacker: Player;
let defender: Player;
const region = (id: number): HistoricalRegion => ({
  id,
  name: `Region ${id}`,
  founderID: "b",
  tileCount: 1,
  representativeTile: 0,
  resources: { food: 0, materials: 0, fuel: 0 },
});

beforeEach(async () => {
  game = await setup("plains", {}, [
    new PlayerInfo("A", PlayerType.Human, "a", "a"),
    new PlayerInfo("B", PlayerType.Human, "b", "b"),
  ]);
  attacker = game.player("a");
  defender = game.player("b");
  attacker.conquer(game.ref(50, 50));
  defender.conquer(game.ref(50, 51));
  defender.conquer(game.ref(50, 55));
  attacker.addTroops(1000);
  vi.spyOn(game, "ticksSinceStart").mockReturnValue(300);
  vi.spyOn(game, "historicalRegionAt").mockImplementation((tile) =>
    region(tile === game.ref(50, 55) ? 2 : 1),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("regional assault regression", () => {
  it("rejects an inaccessible region without spending troops or declaring war", () => {
    const troops = attacker.troops();
    const attack = new AttackExecution(
      100,
      attacker,
      defender.id(),
      null,
      true,
      2,
    );
    attack.init(game, game.ticks());
    expect(attack.isActive()).toBe(false);
    expect(attacker.troops()).toBe(troops);
    expect(attacker.outgoingAttacks()).toHaveLength(0);
    expect(attacker.isWarAuthorizedAgainst(defender)).toBe(false);
  });

  it("ends a stale regional war before deducting troops", () => {
    attacker.authorizeWarAgainst(defender, 1800, null);
    attacker.setWarGoalRegionAgainst(defender, 3);
    const troops = attacker.troops();
    const attack = new AttackExecution(
      100,
      attacker,
      defender.id(),
      null,
      true,
      1,
    );
    attack.init(game, game.ticks());
    expect(attack.isActive()).toBe(false);
    expect(attacker.troops()).toBe(troops);
    expect(attacker.warGoalRegionAgainst(defender)).toBeNull();
    expect(attacker.nonAggressionPactWith(defender)).toBe(game.ticks() + 1200);
  });

  it.each([
    null,
    CasusBelliType.Retaliation,
    CasusBelliType.BorderClaim,
    CasusBelliType.Containment,
    CasusBelliType.TreatyViolation,
  ])("ends a completed regional war for CB %s", (cb) => {
    if (cb !== null) attacker.grantCasusBelli(defender, cb);
    const attack = new AttackExecution(
      100,
      attacker,
      defender.id(),
      null,
      true,
      1,
    );
    attack.init(game, game.ticks());
    expect(attack.isActive()).toBe(true);
    for (let i = 0; i < 30 && attack.isActive(); i++) attack.tick(game.ticks());
    expect(game.owner(game.ref(50, 51))).toBe(attacker);
    expect(game.owner(game.ref(50, 55))).toBe(defender);
    expect(attacker.isWarAuthorizedAgainst(defender)).toBe(false);
    expect(attacker.nonAggressionPactWith(defender)).toBe(game.ticks() + 1200);
    expect(defender.nonAggressionPactWith(attacker)).toBe(game.ticks() + 1200);
  });

  it("returns committed troops when peace ends an existing charge", () => {
    const troops = attacker.troops();
    const attack = new AttackExecution(
      100,
      attacker,
      defender.id(),
      null,
      true,
      1,
    );
    attack.init(game, game.ticks());
    attacker.concludePeaceWith(defender);
    attack.tick(game.ticks());
    expect(attack.isActive()).toBe(false);
    expect(attacker.troops()).toBe(troops);
    expect(game.owner(game.ref(50, 51))).toBe(defender);
  });

  it("recognizes objective completion by another offensive", () => {
    const attack = new AttackExecution(
      100,
      attacker,
      defender.id(),
      null,
      true,
      1,
    );
    attack.init(game, game.ticks());
    attacker.conquer(game.ref(50, 51));
    attack.tick(game.ticks());
    expect(attack.isActive()).toBe(false);
    expect(attacker.nonAggressionPactWith(defender)).toBe(game.ticks() + 1200);
  });
});

describe("post-war truces", () => {
  it("keeps ordinary NAPs distinct and clears both sides on treaty break", () => {
    attacker.setNonAggressionPact(defender);
    expect(attacker.toUpdate()?.truces).toEqual([]);
    attacker.concludePeaceWith(defender);
    expect(attacker.toUpdate()?.truces).toEqual([
      { otherID: "b", expiresAt: game.ticks() + 1200 },
    ]);
    expect(defender.toUpdate()?.truces).toEqual([
      { otherID: "a", expiresAt: game.ticks() + 1200 },
    ]);
    attacker.breakNonAggressionPact(defender);
    expect(attacker.toUpdate()?.truces).toEqual([]);
    expect(defender.toUpdate()?.truces).toEqual([]);
  });

  it("removes expired truces from updates", () => {
    attacker.concludePeaceWith(defender);
    attacker.toUpdate();
    vi.spyOn(game, "ticks").mockReturnValue(game.ticks() + 1200);
    expect(attacker.toUpdate()?.truces).toEqual([]);
  });

  it("transmits truce additions and removals in update diffs", () => {
    const before = makePlayerUpdate({ truces: [] });
    const after = makePlayerUpdate({
      truces: [{ otherID: "b", expiresAt: 1200 }],
    });
    expect(diffPlayerUpdate(before, after)?.truces).toEqual(after.truces);
    expect(diffPlayerUpdate(after, before)?.truces).toEqual([]);
  });
});

describe("structured diplomatic relations", () => {
  it("tracks bounded opinion, trust and perceived threat independently", () => {
    expect(attacker.relationScore(defender)).toBe(0);
    expect(attacker.trust(defender)).toBe(50);
    const initialThreat = attacker.perceivedThreat(defender);
    attacker.updateRelation(defender, -500);
    attacker.changeTrust(defender, 500);
    defender.changeThreat(80);
    expect(attacker.relationScore(defender)).toBe(-100);
    expect(attacker.trust(defender)).toBe(100);
    expect(attacker.perceivedThreat(defender)).toBeGreaterThan(initialThreat);
    expect(attacker.perceivedThreat(defender)).toBeLessThanOrEqual(100);
  });

  it("keeps a bounded chronological memory and exposes it to the client", () => {
    for (let i = 0; i < 30; i++) {
      attacker.rememberDiplomaticEvent(defender, "nap_signed", 10, 10);
    }
    expect(attacker.diplomaticMemories()).toHaveLength(24);
    const update = attacker.toUpdate();
    expect(update?.diplomaticMemories).toHaveLength(24);
    expect(update?.diplomaticRelations).toEqual([
      expect.objectContaining({
        otherID: defender.id(),
        opinion: 0,
        trust: 50,
      }),
    ]);
  });

  it("records treaties, war and peace from each country's perspective", () => {
    attacker.setNonAggressionPact(defender);
    attacker.breakNonAggressionPact(defender);
    expect(defender.trust(attacker)).toBe(20);
    const attack = new AttackExecution(
      100,
      attacker,
      defender.id(),
      null,
      true,
      1,
    );
    attack.init(game, game.ticks());
    expect(defender.trust(attacker)).toBe(0);
    let memories = defender.diplomaticMemories();
    expect(memories[memories.length - 1]?.type).toBe("war_started");
    attacker.concludePeaceWith(defender);
    memories = defender.diplomaticMemories();
    expect(memories[memories.length - 1]?.type).toBe("peace_signed");
  });
});

describe("mandatory post-war ceasefire", () => {
  it("blocks fresh land assaults in both directions without spending troops", () => {
    attacker.concludePeaceWith(defender);
    for (const [from, to] of [
      [attacker, defender],
      [defender, attacker],
    ]) {
      const troops = from.troops();
      expect(from.canAttackPlayer(to)).toBe(false);
      expect(from.canAttack([...to.tiles()][0])).toBe(false);
      const attack = new AttackExecution(100, from, to.id(), null, true, 1);
      attack.init(game, game.ticks());
      expect(attack.isActive()).toBe(false);
      expect(from.troops()).toBe(troops);
      expect(from.truceWith(to)).toBe(game.ticks() + 1200);
      expect(from.isWarAuthorizedAgainst(to)).toBe(false);
    }
  });

  it("blocks new transport orders without spending troops", async () => {
    const { TransportShipExecution } =
      await import("../src/core/execution/TransportShipExecution");
    attacker.concludePeaceWith(defender);
    const troops = attacker.troops();
    const boat = new TransportShipExecution(attacker, game.ref(50, 51), 100);
    boat.init(game, game.ticks());
    expect(boat.isActive()).toBe(false);
    expect(attacker.troops()).toBe(troops);
  });

  it("refunds troops from a landing rejected during a truce", () => {
    attacker.concludePeaceWith(defender);
    const troops = attacker.troops();
    const attack = new AttackExecution(
      100,
      attacker,
      defender.id(),
      game.ref(50, 50),
      false,
      1,
    );
    attack.init(game, game.ticks());
    expect(attack.isActive()).toBe(false);
    expect(attacker.troops()).toBe(troops + 100);
  });

  it("allows attacks again at the exact expiry tick", () => {
    attacker.concludePeaceWith(defender);
    const expiry = game.ticks() + 1200;
    vi.spyOn(game, "ticks").mockReturnValue(expiry - 1);
    expect(attacker.canAttackPlayer(defender)).toBe(false);
    vi.spyOn(game, "ticks").mockReturnValue(expiry);
    expect(attacker.canAttackPlayer(defender)).toBe(true);
    expect(defender.canAttackPlayer(attacker)).toBe(true);
    expect(attacker.truceWith(defender)).toBeNull();
  });

  it("keeps voluntary NAPs breakable", () => {
    attacker.setNonAggressionPact(defender);
    expect(attacker.canAttackPlayer(defender)).toBe(true);
    const attack = new AttackExecution(
      100,
      attacker,
      defender.id(),
      null,
      true,
      1,
    );
    attack.init(game, game.ticks());
    expect(attack.isActive()).toBe(true);
    expect(attacker.nonAggressionPactWith(defender)).toBeNull();
  });
});

describe("strategic resource economy", () => {
  it("computes non-negative consumption and exposes net-balance inputs", () => {
    const consumption = attacker.resourceConsumption();
    expect(consumption.food).toBeGreaterThan(0);
    expect(consumption.materials).toBeGreaterThan(0);
    expect(consumption.fuel).toBeGreaterThan(0);
    const update = attacker.toUpdate();
    expect(update?.foodConsumption).toBeCloseTo(consumption.food);
    expect(update?.materialsConsumption).toBeCloseTo(consumption.materials);
    expect(update?.fuelConsumption).toBeCloseTo(consumption.fuel);
    expect(update?.resourceShortages).toEqual({
      food: false,
      materials: false,
      fuel: false,
    });
  });

  it("clamps resource stocks instead of allowing negative inventories", () => {
    attacker.addResources({
      food: -10_000,
      materials: -10_000,
      fuel: -10_000,
    });
    expect(attacker.resources()).toEqual({ food: 0, materials: 0, fuel: 0 });
    expect(attacker.toUpdate()?.resourceShortages?.food).toBe(true);
  });
});
