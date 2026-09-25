import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { DiplomacyPlusExecution } from "../src/core/execution/DiplomacyPlusExecution";
import {
  buildPoliticalSnapshot,
  submitPoliticalDecision,
} from "../src/core/execution/PoliticalDecisionAdapter";
import {
  CasusBelliType,
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let actor: Player;
let target: Player;

beforeEach(async () => {
  game = await setup("plains", {}, [
    new PlayerInfo("Actor", PlayerType.Human, "actor", "actor"),
    new PlayerInfo("Target", PlayerType.Nation, "target", "target"),
  ]);
  actor = game.player("actor");
  target = game.player("target");
  actor.conquer(game.ref(50, 50));
  target.conquer(game.ref(50, 51));
  actor.addTroops(2000);
  actor.addGold(10_000n);
  vi.spyOn(game, "ticksSinceStart").mockReturnValue(300);
});

describe("military logistics", () => {
  it("rejects an offensive before spending troops when supplies are empty", () => {
    actor.addResources({ food: -10_000, materials: 0, fuel: -10_000 });
    const troops = actor.troops();
    const attack = new AttackExecution(500, actor, target.id());
    attack.init(game, game.ticks());
    expect(attack.isActive()).toBe(false);
    expect(actor.troops()).toBe(troops);
    expect(actor.outgoingAttacks()).toHaveLength(0);
  });

  it("charges supplies once when a valid offensive begins", () => {
    const before = actor.resources();
    const attack = new AttackExecution(500, actor, target.id());
    attack.init(game, game.ticks());
    expect(attack.isActive()).toBe(true);
    expect(actor.resources().food).toBeLessThan(before.food);
    expect(actor.resources().fuel).toBeLessThan(before.fuel);
  });
});

describe("domestic politics", () => {
  it("uses tax policy for income and lets shortages reduce satisfaction", () => {
    actor.setTaxPolicy("high");
    expect(actor.taxIncomeMultiplierPercent()).toBe(125);
    const satisfaction = actor.publicSatisfaction();
    actor.addResources({ food: -10_000, materials: -10_000, fuel: -10_000 });
    actor.updateDomesticPolitics();
    expect(actor.publicSatisfaction()).toBeLessThan(satisfaction);
    expect(actor.stability()).toBeGreaterThanOrEqual(0);
    expect(actor.stability()).toBeLessThanOrEqual(100);
  });

  it("offers five tax levels with stronger revenue and satisfaction tradeoffs", () => {
    actor.setTaxPolicy("very_low");
    expect(actor.taxIncomeMultiplierPercent()).toBe(60);
    actor.setTaxPolicy("very_high");
    expect(actor.taxIncomeMultiplierPercent()).toBe(155);
    const satisfaction = actor.publicSatisfaction();
    actor.updateDomesticPolitics();
    expect(actor.publicSatisfaction()).toBeLessThan(satisfaction);
  });

  it("changes government without erasing national obligations", () => {
    const before = actor.governmentProfile();
    actor.setNonAggressionPact(target, before.termEndsAt + 100);
    actor.setTradeAgreement(target, before.termEndsAt + 100);
    vi.spyOn(game, "ticks").mockReturnValue(before.termEndsAt);
    actor.updateDomesticPolitics();
    expect(actor.governmentProfile().generation).toBe(before.generation + 1);
    expect(actor.nonAggressionPactWith(target)).not.toBeNull();
    expect(actor.tradeAgreementWith(target)).not.toBeNull();
  });
});

describe("national mobilization", () => {
  it("uses a bounded percentage target instead of regional formations", () => {
    actor.setMobilizationTarget(25);
    expect(actor.mobilizationTarget()).toBe(25);
    actor.setMobilizationTarget(150);
    expect(actor.mobilizationTarget()).toBe(100);
    actor.setMobilizationTarget(-10);
    expect(actor.mobilizationTarget()).toBe(0);
  });

  it("treats mobilization as a gradual target", () => {
    const config = game.config();
    actor.setMobilizationTarget(0);
    expect(config.troopIncreaseRate(actor)).toBeLessThan(0);
    actor.setTroops(0);
    expect(config.troopIncreaseRate(actor)).toBe(0);
    actor.setMobilizationTarget(50);
    expect(config.troopIncreaseRate(actor)).toBeGreaterThan(0);
  });

  it("lets cities provide manpower while bases constrain usable capacity", () => {
    const config = game.config();
    const baselinePotential = config.civilianManpowerPotential(actor);
    const baselineCapacity = config.maxTroops(actor);
    const cityTile = game.ref(49, 50);
    actor.conquer(cityTile);
    actor.buildUnit(UnitType.City, cityTile, {});
    expect(config.civilianManpowerPotential(actor)).toBeGreaterThan(
      baselinePotential,
    );
    const capacityWithCity = config.maxTroops(actor);
    expect(capacityWithCity).toBeGreaterThan(baselineCapacity);

    const baseTile = game.ref(48, 50);
    actor.conquer(baseTile);
    actor.buildUnit(UnitType.DefensePost, baseTile, {});
    expect(config.maxTroops(actor)).toBeGreaterThan(capacityWithCity);
    expect(config.maxTroops(actor)).toBeLessThanOrEqual(
      config.civilianManpowerPotential(actor),
    );
  });
});

describe("negotiated peace and crisis exits", () => {
  it("charges reparations and creates a longer bilateral truce", () => {
    actor.authorizeWarAgainst(target);
    target.addGold(1000n);
    const actorGold = actor.gold();
    const peace = new DiplomacyPlusExecution(
      actor,
      target.id(),
      "demand_reparations",
    );
    peace.init(game, game.ticks());
    peace.tick(game.ticks());
    expect(actor.gold()).toBe(actorGold + 500n);
    expect(actor.truceWith(target)).toBe(game.ticks() + 1800);
    expect(target.truceWith(actor)).toBe(game.ticks() + 1800);
  });

  it("lets a crisis target pay a concession before the deadline", () => {
    expect(target.startDiplomaticCrisis(actor)).toBe(true);
    const crisis = actor.diplomaticCrises()[0];
    const totalGold = actor.gold() + target.gold();
    expect(actor.offerCrisisConcession(target)).toBe(true);
    expect(crisis.status).toBe("complied");
    expect(actor.gold() + target.gold()).toBe(totalGold);
  });
});

describe("optional political decision adapter", () => {
  it("builds bounded structured state without exposing mutation methods", () => {
    const snapshot = buildPoliticalSnapshot(game, actor);
    expect(snapshot.country.id).toBe(actor.id());
    expect(snapshot.country.resources).toEqual(actor.resources());
    expect(snapshot.relations[0]).toEqual(
      expect.objectContaining({ otherID: target.id(), canTrade: true }),
    );
  });

  it("rejects stale or invalid decisions before they reach the engine", () => {
    expect(
      submitPoliticalDecision(game, actor, {
        kind: "trade",
        targetID: target.id(),
        direction: "buy",
        resource: "food",
        amount: -1,
        price: 100,
        deliveries: 3,
      }),
    ).toEqual({ accepted: false, reason: "invalid_trade" });
    expect(
      submitPoliticalDecision(game, actor, {
        kind: "embargo",
        targetID: "missing",
        action: "start",
      }),
    ).toEqual({ accepted: false, reason: "target_missing" });
  });

  it("rejects an ultimatum during a truce and queues valid policy actions", () => {
    actor.concludePeaceWith(target);
    expect(
      submitPoliticalDecision(game, actor, {
        kind: "diplomacy",
        targetID: target.id(),
        action: "ultimatum",
      }),
    ).toEqual({ accepted: false, reason: "active_truce" });
    expect(
      submitPoliticalDecision(game, actor, {
        kind: "domestic_policy",
        taxPolicy: "low",
      }),
    ).toEqual({ accepted: true, reason: "queued" });
  });
});

describe("tribe exclusion", () => {
  it("keeps vanilla tribes outside every Diplomacy+ entry point", async () => {
    const tribeGame = await setup("plains", {}, [
      new PlayerInfo("Country", PlayerType.Human, "country", "country"),
      new PlayerInfo("Tribe", PlayerType.Bot, null, "tribe"),
    ]);
    const country = tribeGame.player("country");
    const tribe = tribeGame.player("tribe");
    country.conquer(tribeGame.ref(50, 50));
    tribe.conquer(tribeGame.ref(50, 51));

    country.setNonAggressionPact(tribe);
    country.grantCasusBelli(tribe, CasusBelliType.Retaliation, 100);
    country.setTradeAgreement(tribe);
    country.setGuarantee(tribe, true);

    expect(country.nonAggressionPactWith(tribe)).toBeNull();
    expect(country.casusBelliAgainst(tribe)).toBeNull();
    expect(country.tradeAgreementWith(tribe)).toBeNull();
    expect(country.guarantees(tribe)).toBe(false);
    expect(country.canTrade(tribe)).toBe(false);
    expect(() => buildPoliticalSnapshot(tribeGame, tribe)).toThrow(
      "unavailable for tribes",
    );
    expect(
      submitPoliticalDecision(tribeGame, tribe, {
        kind: "domestic_policy",
        taxPolicy: "high",
      }),
    ).toEqual({ accepted: false, reason: "unsupported_country_type" });

    const update = tribe.toUpdate();
    expect(update?.foodProduction).toBeUndefined();
    expect(update?.diplomaticRelations).toBeUndefined();
    expect(update?.militaryCapacity).toBeUndefined();
    expect(update?.governmentProfile).toBeUndefined();

    tribe.addTroops(2_000);
    tribe.addResources({ food: -10_000, materials: 0, fuel: -10_000 });
    vi.spyOn(tribeGame, "ticksSinceStart").mockReturnValue(300);
    const emptyStocks = tribe.resources();
    const vanillaAttack = new AttackExecution(500, tribe, country.id());
    vanillaAttack.init(tribeGame, tribeGame.ticks());
    expect(vanillaAttack.isActive()).toBe(true);
    expect(tribe.resources()).toEqual(emptyStocks);
    expect(tribe.isWarAuthorizedAgainst(country)).toBe(false);
  });
});
