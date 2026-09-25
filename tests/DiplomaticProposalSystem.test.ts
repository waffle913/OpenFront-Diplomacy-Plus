import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiplomaticProposalExecution } from "../src/core/execution/DiplomaticProposalExecution";
import { evaluateDiplomaticProposal } from "../src/core/game/DiplomaticProposalEvaluation";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
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
