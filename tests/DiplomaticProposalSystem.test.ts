import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiplomaticProposalExecution } from "../src/core/execution/DiplomaticProposalExecution";
import { chooseDiplomaticInitiative } from "../src/core/game/DiplomaticInitiative";
import { evaluateDiplomaticProposal } from "../src/core/game/DiplomaticProposalEvaluation";
import {
  Game,
  HistoricalRegion,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let proposer: Player;
let recipient: Player;

beforeEach(async () => {
  game = await setup("plains", {}, [
    new PlayerInfo("Proposer", PlayerType.Human, "proposer", "proposer"),
    new PlayerInfo("Recipient", PlayerType.Nation, null, "recipient"),
  ]);
  proposer = game.player("proposer");
  recipient = game.player("recipient");
  proposer.conquer(game.ref(50, 50));
  recipient.conquer(game.ref(50, 51));
  proposer.addGold(10_000n);
  recipient.addGold(10_000n);
  vi.spyOn(game, "ticksSinceStart").mockReturnValue(300);
});

describe("DiplomacyRegistry lifecycle", () => {
  it("validates participants and rejects duplicate pending offers with reasons", async () => {
    const first = game.createDiplomaticProposal(proposer, recipient, [
      { kind: "non_aggression_pact", durationTicks: 3600 },
    ]);
    expect(first.accepted).toBe(true);
    const duplicate = game.createDiplomaticProposal(proposer, recipient, [
      { kind: "non_aggression_pact", durationTicks: 3600 },
    ]);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.reasons[0].code).toBe("duplicate_pending");

    const tribeGame = await setup("plains", {}, [
      new PlayerInfo("Human", PlayerType.Human, "human", "human"),
      new PlayerInfo("Tribe", PlayerType.Bot, null, "tribe"),
    ]);
    const invalid = tribeGame.createDiplomaticProposal(
      tribeGame.player("human"),
      tribeGame.player("tribe"),
      [{ kind: "trade_agreement", durationTicks: 3600 }],
    );
    expect(invalid.accepted).toBe(false);
    expect(
      invalid.reasons.some((reason) => reason.code === "invalid_participant"),
    ).toBe(true);
  });

  it("settles accepted terms together on the next simulation tick", () => {
    const result = game.createDiplomaticProposal(proposer, recipient, [
      { kind: "non_aggression_pact", durationTicks: 3600 },
      { kind: "trade_agreement", durationTicks: 3600 },
    ]);
    const proposal = result.proposal!;
    expect(
      game.acceptDiplomaticProposal(recipient, proposal.id, [
        { code: "high_trust", impact: 18, detail: "68" },
      ]).accepted,
    ).toBe(true);
    expect(proposal.status).toBe("accepted_pending_settlement");
    expect(proposer.nonAggressionPactWith(recipient)).toBeNull();
    game.executeNextTick();
    expect(proposal.status).toBe("settled");
    expect(proposal.reasons).toEqual([
      { code: "high_trust", impact: 18, detail: "68" },
    ]);
    expect(proposer.nonAggressionPactWith(recipient)).not.toBeNull();
    expect(proposer.tradeAgreementWith(recipient)).not.toBeNull();
  });

  it("invalidates atomically when settlement preconditions changed", () => {
    const result = game.createDiplomaticProposal(proposer, recipient, [
      { kind: "non_aggression_pact", durationTicks: 3600 },
      { kind: "trade_agreement", durationTicks: 3600 },
    ]);
    const proposal = result.proposal!;
    game.acceptDiplomaticProposal(recipient, proposal.id);
    proposer.addEmbargo(recipient, false);
    game.executeNextTick();
    expect(proposal.status).toBe("invalidated");
    expect(
      proposal.reasons.some((reason) => reason.code === "trade_blocked"),
    ).toBe(true);
    expect(proposer.nonAggressionPactWith(recipient)).toBeNull();
    expect(proposer.tradeAgreementWith(recipient)).toBeNull();
  });

  it("supports rejection and proposer-only withdrawal", () => {
    const rejected = game.createDiplomaticProposal(proposer, recipient, [
      { kind: "non_aggression_pact", durationTicks: 1200 },
    ]).proposal!;
    expect(game.rejectDiplomaticProposal(recipient, rejected.id).accepted).toBe(
      true,
    );
    expect(rejected.status).toBe("rejected");

    const withdrawn = game.createDiplomaticProposal(proposer, recipient, [
      { kind: "trade_agreement", durationTicks: 1200 },
    ]).proposal!;
    expect(
      game.withdrawDiplomaticProposal(recipient, withdrawn.id).accepted,
    ).toBe(false);
    expect(
      game.withdrawDiplomaticProposal(proposer, withdrawn.id).accepted,
    ).toBe(true);
    expect(withdrawn.status).toBe("withdrawn");
  });

  it("negotiates an embargo lift through atomic settlement", () => {
    recipient.addEmbargo(proposer, false);
    const proposal = game.createDiplomaticProposal(proposer, recipient, [
      {
        kind: "lift_embargo",
        embargoerID: recipient.id(),
        targetID: proposer.id(),
      },
      { kind: "non_aggression_pact", durationTicks: 1200 },
    ]).proposal!;
    expect(game.acceptDiplomaticProposal(recipient, proposal.id).accepted).toBe(
      true,
    );
    game.executeNextTick();
    expect(proposal.status).toBe("settled");
    expect(recipient.hasEmbargoAgainst(proposer)).toBe(false);
    expect(recipient.nonAggressionPactWith(proposer)).not.toBeNull();
  });

  it("creates immutable counter-proposal revisions", () => {
    const original = game.createDiplomaticProposal(proposer, recipient, [
      { kind: "non_aggression_pact", durationTicks: 3600 },
    ]).proposal!;
    const originalTerms = JSON.stringify(original.terms);
    const counter = game.counterDiplomaticProposal(recipient, original.id, [
      { kind: "non_aggression_pact", durationTicks: 1800 },
    ]);
    expect(counter.accepted).toBe(true);
    expect(original.status).toBe("countered");
    expect(JSON.stringify(original.terms)).toBe(originalTerms);
    expect(counter.proposal).toMatchObject({
      rootProposalID: original.id,
      parentProposalID: original.id,
      revision: 1,
      proposerID: recipient.id(),
      recipientID: proposer.id(),
    });
  });

  it("expires pending offers and changes the deterministic diplomacy hash", () => {
    const before = game.diplomaticStateHash();
    const proposal = game.createDiplomaticProposal(proposer, recipient, [
      { kind: "non_aggression_pact", durationTicks: 3600 },
    ]).proposal!;
    expect(game.diplomaticStateHash()).not.toBe(before);
    const current = game.ticks();
    vi.spyOn(game, "ticks").mockReturnValue(current + 601);
    game.executeNextTick();
    expect(proposal.status).toBe("expired");
  });
});

describe("proposal decisions and pause semantics", () => {
  it("returns deterministic, structured and explainable AI reasons", () => {
    const proposal = game.createDiplomaticProposal(proposer, recipient, [
      { kind: "trade_agreement", durationTicks: 3600 },
    ]).proposal!;
    const first = evaluateDiplomaticProposal(game, recipient, proposal);
    const second = evaluateDiplomaticProposal(game, recipient, proposal);
    expect(first).toEqual(second);
    expect(first.reasons.length).toBeGreaterThan(0);
    expect(
      first.reasons.every((reason) => Number.isFinite(reason.impact)),
    ).toBe(true);
  });

  it("processes create and accept while paused without applying terms", () => {
    const ticks = game.ticks();
    game.executePausedActions([
      new DiplomaticProposalExecution(
        proposer,
        "create",
        recipient.id(),
        undefined,
        [{ kind: "non_aggression_pact", durationTicks: 3600 }],
      ),
    ]);
    const proposal = game.diplomaticProposalsFor(proposer.id())[0];
    game.executePausedActions([
      new DiplomaticProposalExecution(
        recipient,
        "accept",
        undefined,
        proposal.id,
      ),
    ]);
    expect(game.ticks()).toBe(ticks);
    expect(proposal.status).toBe("accepted_pending_settlement");
    expect(proposer.nonAggressionPactWith(recipient)).toBeNull();
    game.executeNextTick();
    expect(proposal.status).toBe("settled");
  });
});

describe("regional peace terms", () => {
  function installRegion(
    regionTiles: readonly number[],
    founderID = proposer.id(),
  ): HistoricalRegion {
    const tileSet = new Set(regionTiles);
    const region: HistoricalRegion = {
      id: 77,
      name: "Marches du Sud",
      founderID,
      tileCount: regionTiles.length,
      representativeTile: regionTiles[0],
      resources: { food: 8, materials: 5, fuel: 2 },
    };
    vi.spyOn(game, "historicalRegions").mockReturnValue([region]);
    vi.spyOn(game, "historicalRegionAt").mockImplementation((tile) =>
      tileSet.has(tile) ? region : null,
    );
    vi.spyOn(game, "historicalRegionOwnedTiles").mockImplementation(
      (regionID, player) =>
        regionID === region.id
          ? regionTiles.filter((tile) => game.owner(tile) === player).length
          : 0,
    );
    return region;
  }

  it("cedes only the negotiated historical region and its structures", () => {
    const cededTiles = [
      game.ref(30, 30),
      game.ref(30, 31),
      game.ref(31, 30),
      game.ref(31, 31),
    ];
    const retainedTiles = Array.from({ length: 12 }, (_, index) =>
      game.ref(40 + (index % 4), 30 + Math.floor(index / 4)),
    );
    for (const tile of [...cededTiles, ...retainedTiles])
      recipient.conquer(tile);
    installRegion(cededTiles);
    recipient.addGold(1_000_000n);
    const city = recipient.buildUnit(UnitType.City, cededTiles[0], {});
    proposer.setWarGoalRegionAgainst(recipient, 77);

    const proposal = game.createDiplomaticProposal(proposer, recipient, [
      {
        kind: "cede_region",
        cedentID: recipient.id(),
        recipientID: proposer.id(),
        regionID: 77,
      },
    ]).proposal!;
    expect(game.acceptDiplomaticProposal(recipient, proposal.id).accepted).toBe(
      true,
    );
    game.executeNextTick();

    expect(proposal.status).toBe("settled");
    expect(cededTiles.every((tile) => game.owner(tile) === proposer)).toBe(
      true,
    );
    expect(retainedTiles.every((tile) => game.owner(tile) === recipient)).toBe(
      true,
    );
    expect(city.owner()).toBe(proposer);
    expect(proposer.warGoalRegionAgainst(recipient)).toBeNull();
  });

  it("protects a country's founding core and last territory", () => {
    const onlyTiles = [...recipient.tiles()];
    installRegion(onlyTiles, recipient.id());
    const protectedCore = game.createDiplomaticProposal(proposer, recipient, [
      {
        kind: "cede_region",
        cedentID: recipient.id(),
        recipientID: proposer.id(),
        regionID: 77,
      },
    ]);
    expect(protectedCore.accepted).toBe(false);
    expect(protectedCore.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        "protected_national_core",
        "country_elimination_risk",
      ]),
    );
  });

  it("revalidates regional control before applying any package term", () => {
    const cededTiles = [game.ref(30, 30), game.ref(30, 31)];
    const retainedTiles = Array.from({ length: 12 }, (_, index) =>
      game.ref(40 + (index % 4), 30 + Math.floor(index / 4)),
    );
    for (const tile of [...cededTiles, ...retainedTiles])
      recipient.conquer(tile);
    installRegion(cededTiles);
    const proposal = game.createDiplomaticProposal(proposer, recipient, [
      {
        kind: "cede_region",
        cedentID: recipient.id(),
        recipientID: proposer.id(),
        regionID: 77,
      },
      { kind: "non_aggression_pact", durationTicks: 1200 },
    ]).proposal!;
    game.acceptDiplomaticProposal(recipient, proposal.id);
    for (const tile of cededTiles) proposer.conquer(tile);
    game.executeNextTick();

    expect(proposal.status).toBe("invalidated");
    expect(
      proposal.reasons.some(
        (reason) => reason.code === "region_not_controlled",
      ),
    ).toBe(true);
    expect(proposer.nonAggressionPactWith(recipient)).toBeNull();
  });

  it("lets an advantaged AI negotiate its declared regional war goal", () => {
    const cededTiles = [game.ref(30, 30), game.ref(30, 31)];
    const retainedTiles = Array.from({ length: 12 }, (_, index) =>
      game.ref(40 + (index % 4), 30 + Math.floor(index / 4)),
    );
    for (const tile of [...cededTiles, ...retainedTiles])
      recipient.conquer(tile);
    installRegion(cededTiles);
    proposer.addTroops(10_000);
    recipient.addTroops(1_000);
    proposer.authorizeWarAgainst(recipient);
    proposer.setWarGoalRegionAgainst(recipient, 77);

    expect(chooseDiplomaticInitiative(game, proposer)).toMatchObject({
      targetID: recipient.id(),
      terms: [
        {
          kind: "cede_region",
          cedentID: recipient.id(),
          recipientID: proposer.id(),
          regionID: 77,
        },
        { kind: "end_war", truceTicks: 1800 },
      ],
      reasons: [{ code: "strategic_region" }],
    });
  });
});
