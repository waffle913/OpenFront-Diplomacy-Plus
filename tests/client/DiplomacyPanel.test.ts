import { describe, expect, it } from "vitest";
import { DiplomacyPanel } from "../../src/client/hud/layers/DiplomacyPanel";
import { GameView, PlayerView } from "../../src/client/view";
import { PlayerType } from "../../src/core/game/Game";

describe("EU4-style country menu", () => {
  it("navigates to diplomacy and updates treaty deadlines", async () => {
    let now = 100;
    const selected = {
      id: () => "a",
      type: () => PlayerType.Human,
      isAlive: () => true,
      displayName: () => "Country A",
      gold: () => 1000n,
      troops: () => 500,
      isAlliedWith: () => false,
      hasEmbargo: () => false,
      truces: () => [{ otherID: "b", expiresAt: 1300 }],
      diplomaticRelations: () => [],
      tradeContracts: () => [],
      diplomaticCrises: () => [],
      diplomaticProposals: () => [],
      diplomaticIncidents: () => [],
      stability: () => 70,
      publicSatisfaction: () => 65,
      taxPolicy: () => "normal",
      tradeAgreements: () => [],
      governmentProfile: () => ({
        leaderName: "Government 1",
        style: "pragmatic",
        generation: 1,
        termEndsAt: 3600,
        tradeBias: 0.05,
        riskTolerance: 0.55,
      }),
      nationalInterests: () => ({
        security: 30,
        expansion: 5,
        resourceAccess: "food",
        preferredPartners: [],
      }),
      nationalAgenda: () => undefined,
      diplomaticMemories: () => [],
      nonAggressionPacts: () => [{ otherID: "b", expiresAt: 1300 }],
      outgoingAttacks: () => [],
      incomingAttacks: () => [],
      targets: () => [],
      casusBelli: () => [],
      allies: () => [],
      guarantees: () => [],
      threat: () => 0,
      reputation: () => 100,
      food: () => 0,
      materials: () => 0,
      fuel: () => 0,
      foodProduction: () => 0,
      materialsProduction: () => 0,
      fuelProduction: () => 0,
      foodConsumption: () => 0,
      materialsConsumption: () => 0,
      fuelConsumption: () => 0,
      resourceShortages: () => ({
        food: false,
        materials: false,
        fuel: false,
      }),
    } as unknown as PlayerView;
    const panel = new DiplomacyPanel();
    panel.game = {
      ticks: () => now,
      myPlayer: () => selected,
      ticksSinceStart: () => now,
      player: (id: string) =>
        id === "a" ? selected : { displayName: () => "Country B" },
      historicalRegions: () => [],
      players: () => [selected],
    } as unknown as GameView;
    document.body.append(panel);
    try {
      panel.show(selected);
      await panel.updateComplete;
      const tabs = panel.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      const diplomacyTab = Array.from(tabs).find((tab) =>
        tab.textContent?.includes("Diplomatie"),
      )!;
      expect(panel.textContent).toContain("CONSEIL D'ÉTAT");
      diplomacyTab.click();
      await panel.updateComplete;
      expect(diplomacyTab.getAttribute("aria-selected")).toBe("true");
      expect(panel.textContent).toContain("Trêve avec Country B");
      expect(panel.textContent).toContain("11 mai · an 1");
      now = 1300;
      panel.tick();
      await panel.updateComplete;
      expect(panel.textContent).not.toContain("Trêve avec Country B");
    } finally {
      panel.remove();
    }
  });
});
