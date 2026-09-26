import { describe, expect, it } from "vitest";
import {
  DiplomacyNotification,
  diplomaticTermLabel,
} from "../../src/client/hud/layers/DiplomacyNotification";
import { GameView, PlayerView } from "../../src/client/view";
import { DiplomaticProposal } from "../../src/core/game/Game";

describe("diplomacy notifications", () => {
  it("uses readable labels for the main diplomatic terms", () => {
    expect(
      diplomaticTermLabel([
        { kind: "non_aggression_pact", durationTicks: 3600 },
      ]),
    ).toBe("pacte de non-agression");
    expect(
      diplomaticTermLabel([{ kind: "trade_agreement", durationTicks: 3600 }]),
    ).toBe("accord commercial");
  });

  it("announces a received NAP and its rejection without replaying history", () => {
    const proposals: DiplomaticProposal[] = [];
    const memories: any[] = [];
    const contracts: any[] = [];
    const incidents: any[] = [];
    const resolutions: any[] = [];
    const base = {
      isPlayer: () => true,
      allies: () => [],
      isRequestingAllianceWith: () => false,
    };
    const me = {
      ...base,
      id: () => "me",
      displayName: () => "France",
      diplomaticProposals: () => proposals,
      tradeContracts: () => contracts,
      diplomaticIncidents: () => incidents,
      internationalResolutions: () => resolutions,
      diplomaticMemories: () => memories,
      casusBelli: () => [],
    } as unknown as PlayerView;
    const other = {
      ...base,
      id: () => "other",
      displayName: () => "Espagne",
    } as unknown as PlayerView;
    const game = {
      inSpawnPhase: () => false,
      myPlayer: () => me,
      players: () => [me, other],
      ticks: () => 100,
      player: (id: string) => (id === "me" ? me : other),
    } as unknown as GameView;
    const notification = new DiplomacyNotification();
    notification.game = game;
    notification.init();
    expect((notification as any).notices).toHaveLength(0);

    proposals.push({
      id: "dp:1",
      rootProposalID: "dp:1",
      revision: 0,
      proposerID: "other",
      recipientID: "me",
      createdAt: 100,
      responseAfter: 110,
      expiresAt: 700,
      status: "pending",
      terms: [{ kind: "non_aggression_pact", durationTicks: 3600 }],
      reasons: [],
    });
    notification.tick();
    expect((notification as any).notices.at(-1)).toMatchObject({
      title: "Demande diplomatique reçue",
      body: "Espagne propose un pacte de non-agression.",
    });

    proposals[0].status = "rejected";
    notification.tick();
    expect((notification as any).notices.at(-1)).toMatchObject({
      title: "Refus transmis",
    });
  });
});
