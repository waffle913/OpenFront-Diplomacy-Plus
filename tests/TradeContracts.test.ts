import { beforeEach, describe, expect, it, vi } from "vitest";
import { TradeExecution } from "../src/core/execution/TradeExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  TradeContract,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let buyer: Player;
let seller: Player;

function contract(overrides: Partial<TradeContract> = {}): TradeContract {
  return {
    id: "trade-1",
    sellerID: seller.id(),
    buyerID: buyer.id(),
    resource: "food",
    amountPerDelivery: 25,
    pricePerDelivery: 100,
    intervalTicks: 600,
    nextDeliveryAt: game.ticks(),
    deliveriesRemaining: 1,
    deliveredCount: 0,
    status: "active",
    createdAt: game.ticks(),
    ...overrides,
  };
}

beforeEach(async () => {
  game = await setup("plains", {}, [
    new PlayerInfo("Buyer", PlayerType.Human, "buyer", "buyer"),
    new PlayerInfo("Seller", PlayerType.Nation, "seller", "seller"),
  ]);
  buyer = game.player("buyer");
  seller = game.player("seller");
  buyer.conquer(game.ref(50, 50));
  seller.conquer(game.ref(50, 51));
  buyer.addGold(10_000n);
});

describe("recurring strategic-resource trade", () => {
  it("transfers gold and resources exactly once and completes", () => {
    const deal = contract();
    seller.addTradeContract(deal);
    buyer.addTradeContract(deal);
    const buyerFood = buyer.resources().food;
    const sellerFood = seller.resources().food;
    const buyerGold = buyer.gold();
    const sellerGold = seller.gold();

    seller.processTradeContracts();
    buyer.processTradeContracts();

    expect(buyer.resources().food).toBeCloseTo(buyerFood + 25);
    expect(seller.resources().food).toBeCloseTo(sellerFood - 25);
    expect(buyer.gold()).toBe(buyerGold - 100n);
    expect(seller.gold()).toBe(sellerGold + 100n);
    expect(deal.deliveredCount).toBe(1);
    expect(deal.status).toBe("completed");
  });

  it("never partially transfers when stock or funds are insufficient", () => {
    seller.addResources({ food: -10_000, materials: 0, fuel: 0 });
    const noStock = contract({ id: "no-stock" });
    seller.addTradeContract(noStock);
    buyer.addTradeContract(noStock);
    const buyerGold = buyer.gold();
    seller.processTradeContracts();
    expect(noStock.status).toBe("failed");
    expect(noStock.lastFailure).toBe("insufficient_stock");
    expect(buyer.gold()).toBe(buyerGold);

    seller.addResources({ food: 100, materials: 0, fuel: 0 });
    buyer.removeGold(buyer.gold());
    const noFunds = contract({ id: "no-funds" });
    seller.addTradeContract(noFunds);
    buyer.addTradeContract(noFunds);
    const sellerFood = seller.resources().food;
    seller.processTradeContracts();
    expect(noFunds.status).toBe("failed");
    expect(noFunds.lastFailure).toBe("insufficient_funds");
    expect(seller.resources().food).toBe(sellerFood);
  });

  it("rejects duplicate insertion and supports bilateral cancellation", () => {
    const deal = contract();
    expect(seller.addTradeContract(deal)).toBe(true);
    expect(seller.addTradeContract(deal)).toBe(false);
    expect(buyer.addTradeContract(deal)).toBe(true);
    expect(buyer.cancelTradeContract(deal.id)).toBe(true);
    expect(seller.tradeContracts()[0].status).toBe("cancelled");
    expect(seller.cancelTradeContract(deal.id)).toBe(false);
  });

  it("fails before delivery when either country starts an embargo", () => {
    const deal = contract();
    seller.addTradeContract(deal);
    buyer.addTradeContract(deal);
    buyer.addEmbargo(seller, false);
    seller.processTradeContracts();
    expect(deal.status).toBe("failed");
    expect(deal.lastFailure).toBe("embargo");
  });

  it("advances recurring deliveries and exposes immutable update snapshots", () => {
    let tick = game.ticks();
    vi.spyOn(game, "ticks").mockImplementation(() => tick);
    const deal = contract({ deliveriesRemaining: 2, intervalTicks: 10 });
    seller.addTradeContract(deal);
    buyer.addTradeContract(deal);
    seller.processTradeContracts();
    const first = seller.toUpdate()?.tradeContracts?.[0];
    expect(first?.deliveriesRemaining).toBe(1);
    tick += 10;
    seller.processTradeContracts();
    expect(deal.status).toBe("completed");
    expect(first?.status).toBe("active");
  });

  it("accepts a fair import offer from a nation and prevents duplicates", () => {
    const offer = new TradeExecution(
      buyer,
      seller.id(),
      "offer",
      "buy",
      "food",
      10,
      100,
      3,
    );
    offer.init(game);
    offer.tick();
    expect(buyer.tradeContracts()).toHaveLength(1);
    expect(seller.tradeContracts()).toHaveLength(1);

    const duplicate = new TradeExecution(
      buyer,
      seller.id(),
      "offer",
      "buy",
      "food",
      10,
      100,
      3,
    );
    duplicate.init(game);
    duplicate.tick();
    expect(buyer.tradeContracts()).toHaveLength(1);
  });
});

describe("international cooperation", () => {
  it("moves aid without creating gold and enforces the cooldown", () => {
    const total = buyer.gold() + seller.gold();
    const sellerGold = seller.gold();
    expect(buyer.provideEconomicAid(seller, 500n)).toBe(true);
    expect(seller.gold()).toBe(sellerGold + 500n);
    expect(buyer.gold() + seller.gold()).toBe(total);
    expect(buyer.provideEconomicAid(seller, 500n)).toBe(false);
    expect(seller.trust(buyer)).toBeGreaterThan(50);
  });

  it("charges both partners once for a joint project", () => {
    seller.addGold(1000n);
    const buyerGold = buyer.gold();
    const sellerGold = seller.gold();
    const buyerMaterials = buyer.resources().materials;
    expect(buyer.launchJointProject(seller)).toBe(true);
    expect(buyer.gold()).toBe(buyerGold - 400n);
    expect(seller.gold()).toBe(sellerGold - 400n);
    expect(buyer.resources().materials).toBe(buyerMaterials + 75);
    expect(buyer.launchJointProject(seller)).toBe(false);
  });

  it("creates a bilateral preferred trade agreement with an expiry", () => {
    buyer.setTradeAgreement(seller, 100);
    expect(buyer.tradeAgreementWith(seller)).toBe(game.ticks() + 100);
    expect(seller.tradeAgreementWith(buyer)).toBe(game.ticks() + 100);
  });
});

describe("diplomatic crises", () => {
  it("gives a nation time to comply and records the outcome", () => {
    let tick = game.ticks();
    vi.spyOn(game, "ticks").mockImplementation(() => tick);
    buyer.addTroops(2000);
    seller.changeThreat(80);
    expect(buyer.startDiplomaticCrisis(seller)).toBe(true);
    const crisis = buyer.diplomaticCrises()[0];
    expect(crisis.status).toBe("pending");
    buyer.processDiplomaticCrises();
    expect(crisis.status).toBe("pending");
    tick = crisis.responseAt;
    buyer.processDiplomaticCrises();
    expect(crisis.status).toBe("complied");
    expect(seller.threat()).toBe(65);
    expect(seller.diplomaticCrises()[0]).toBe(crisis);
  });

  it("turns a refused demand into a containment casus belli", () => {
    let tick = game.ticks();
    vi.spyOn(game, "ticks").mockImplementation(() => tick);
    expect(buyer.startDiplomaticCrisis(seller)).toBe(true);
    const crisis = buyer.diplomaticCrises()[0];
    tick = crisis.responseAt;
    buyer.processDiplomaticCrises();
    expect(crisis.status).toBe("refused");
    expect(buyer.casusBelliAgainst(seller)?.type).toBe("containment");
  });

  it("cannot use a crisis to bypass a post-war truce", () => {
    buyer.concludePeaceWith(seller);
    expect(buyer.startDiplomaticCrisis(seller)).toBe(false);
  });
});
