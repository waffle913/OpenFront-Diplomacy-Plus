import {
  Execution,
  Game,
  isDiplomacyPlusParticipant,
  Player,
  PlayerID,
  PlayerType,
  StrategicResource,
  TradeContract,
} from "../game/Game";

export type TradeDirection = "buy" | "sell";

export class TradeExecution implements Execution {
  private mg: Game | null = null;
  private active = true;

  constructor(
    private actor: Player,
    private targetID: PlayerID,
    private action: "offer" | "cancel",
    private direction?: TradeDirection,
    private resource?: StrategicResource,
    private amount?: number,
    private price?: number,
    private deliveries?: number,
    private contractID?: string,
  ) {}

  init(mg: Game): void {
    this.mg = mg;
    if (
      !isDiplomacyPlusParticipant(this.actor) ||
      !mg.hasPlayer(this.targetID) ||
      !isDiplomacyPlusParticipant(mg.player(this.targetID))
    ) {
      this.active = false;
    }
  }

  tick(): void {
    if (!this.active || this.mg === null) return;
    try {
      if (!this.mg.hasPlayer(this.targetID)) return;
      const target = this.mg.player(this.targetID);
      if (target === this.actor || !this.actor.isAlive() || !target.isAlive()) {
        return;
      }
      if (this.action === "cancel") {
        if (this.contractID === undefined) return;
        const contract = this.actor
          .tradeContracts()
          .find((candidate) => candidate.id === this.contractID);
        if (contract === undefined) return;
        if (
          contract.buyerID !== this.actor.id() &&
          contract.sellerID !== this.actor.id()
        ) {
          return;
        }
        this.actor.cancelTradeContract(contract.id);
        target.cancelTradeContract(contract.id);
        return;
      }

      if (
        this.direction === undefined ||
        this.resource === undefined ||
        this.amount === undefined ||
        this.price === undefined ||
        this.deliveries === undefined ||
        !Number.isFinite(this.amount) ||
        !Number.isSafeInteger(this.price) ||
        !Number.isSafeInteger(this.deliveries) ||
        this.amount < 1 ||
        this.amount > 1000 ||
        this.price < 1 ||
        this.price > 1_000_000 ||
        this.deliveries < 1 ||
        this.deliveries > 24 ||
        !this.actor.canTrade(target)
      ) {
        return;
      }

      const seller = this.direction === "buy" ? target : this.actor;
      const buyer = this.direction === "buy" ? this.actor : target;
      if (
        seller
          .tradeContracts()
          .some(
            (contract) =>
              contract.status === "active" &&
              contract.sellerID === seller.id() &&
              contract.buyerID === buyer.id() &&
              contract.resource === this.resource,
          )
      ) {
        return;
      }

      const reservedStock = seller
        .tradeContracts()
        .filter(
          (contract) =>
            contract.status === "active" &&
            contract.sellerID === seller.id() &&
            contract.resource === this.resource,
        )
        .reduce(
          (sum, contract) =>
            sum + contract.amountPerDelivery * contract.deliveriesRemaining,
          0,
        );
      const reservedGold = buyer
        .tradeContracts()
        .filter(
          (contract) =>
            contract.status === "active" && contract.buyerID === buyer.id(),
        )
        .reduce(
          (sum, contract) =>
            sum + contract.pricePerDelivery * contract.deliveriesRemaining,
          0,
        );
      if (
        seller.resources()[this.resource] <
          reservedStock + this.amount * this.deliveries ||
        buyer.gold() < BigInt(reservedGold + this.price * this.deliveries)
      ) {
        return;
      }

      // Human-to-human reply UI is introduced with multiplayer diplomacy.
      // Nations decide from their actual reserve, need, price and relationship.
      if (target.type() !== PlayerType.Nation) return;
      if (!this.nationAccepts(target, seller, buyer)) {
        this.actor.rememberDiplomaticEvent(target, "trade_offer_refused", 0, 0);
        return;
      }

      const contract: TradeContract = {
        id: `${this.mg.ticks()}:${seller.smallID()}:${buyer.smallID()}:${this.resource}:${seller.tradeContracts().length}`,
        sellerID: seller.id(),
        buyerID: buyer.id(),
        resource: this.resource,
        amountPerDelivery: this.amount,
        pricePerDelivery: this.price,
        intervalTicks: 600,
        nextDeliveryAt: this.mg.ticks() + 10,
        deliveriesRemaining: this.deliveries,
        deliveredCount: 0,
        status: "active",
        createdAt: this.mg.ticks(),
      };
      seller.addTradeContract(contract);
      buyer.addTradeContract(contract);
      seller.updateRelation(buyer, 3);
      buyer.updateRelation(seller, 3);
      seller.rememberDiplomaticEvent(buyer, "trade_started", 3, 2);
      buyer.rememberDiplomaticEvent(seller, "trade_started", 3, 2);
    } finally {
      this.active = false;
    }
  }

  private nationAccepts(
    target: Player,
    seller: Player,
    buyer: Player,
  ): boolean {
    const amount = this.amount!;
    const price = this.price!;
    const resource = this.resource!;
    const stock = seller.resources()[resource];
    const sellerReserve = seller.resourceConsumption()[resource] * 20;
    if (stock < amount + sellerReserve || buyer.gold() < BigInt(price)) {
      return false;
    }

    const baseUnitPrice: Record<StrategicResource, number> = {
      food: 10,
      materials: 16,
      fuel: 24,
    };
    const fairPrice = amount * baseUnitPrice[resource];
    const targetIsSeller = target === seller;
    const needRatio =
      target.resourceConsumption()[resource] /
      Math.max(1, target.resources()[resource]);
    const agreementBonus =
      target.tradeAgreementWith(this.actor) !== null ? 0.1 : 0;
    const relationshipModifier =
      (target.trust(this.actor) - 50) / 250 +
      agreementBonus +
      target.governmentProfile().tradeBias;
    if (targetIsSeller) {
      return price >= fairPrice * (0.8 - relationshipModifier);
    }
    return price <= fairPrice * (1.2 + needRatio + relationshipModifier);
  }

  applyDuringPause(): boolean {
    return false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
