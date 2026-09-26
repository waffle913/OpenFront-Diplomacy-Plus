import { beforeEach, describe, expect, it, vi } from "vitest";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { evaluateInternationalResolutionVote } from "../src/core/game/InternationalOrganizationRegistry";
import { setup } from "./util/Setup";

let game: Game;
let founder: Player;
let allyA: Player;
let allyB: Player;
let target: Player;

beforeEach(async () => {
  game = await setup("plains", {}, [
    new PlayerInfo("Founder", PlayerType.Human, "founder", "founder"),
    new PlayerInfo("Ally A", PlayerType.Nation, null, "ally-a"),
    new PlayerInfo("Ally B", PlayerType.Nation, null, "ally-b"),
    new PlayerInfo("Target", PlayerType.Nation, null, "target"),
  ]);
  founder = game.player("founder");
  allyA = game.player("ally-a");
  allyB = game.player("ally-b");
  target = game.player("target");
  [founder, allyA, allyB, target].forEach((player, index) =>
    player.conquer(game.ref(40 + index, 40)),
  );
  target.addGold(10_000n);
  vi.spyOn(game, "ticksSinceStart").mockReturnValue(300);
});

describe("international organization registry", () => {
  it("requires a real multilateral founding coalition", () => {
    expect(
      game.createInternationalOrganization(
        founder,
        "Forum maritime",
        [allyA],
        ["protect_trade"],
      ),
    ).toBeNull();
    expect(
      game.createInternationalOrganization(
        founder,
        "Forum maritime",
        [allyA, allyB],
        ["protect_trade", "mediate_disputes"],
      ),
    ).toMatchObject({
      id: "io:1",
      founderID: founder.id(),
      memberIDs: [allyA.id(), allyB.id(), founder.id()].sort(),
    });
  });

  it("passes collective sanctions by quorum and applies each supporting vote", () => {
    const organization = game.createInternationalOrganization(
      founder,
      "Ligue du commerce",
      [allyA, allyB],
      ["protect_trade", "collective_sanctions"],
    )!;
    const resolution = game.proposeInternationalResolution(
      founder,
      organization.id,
      "collective_sanctions",
      target,
    )!;
    expect(
      game.voteInternationalResolution(
        founder,
        resolution.id,
        "for",
        "Sécurité commerciale",
      ),
    ).toBe(true);
    expect(
      game.voteInternationalResolution(
        allyA,
        resolution.id,
        "for",
        "Responsabilité établie",
      ),
    ).toBe(true);
    expect(
      game.voteInternationalResolution(
        allyB,
        resolution.id,
        "abstain",
        "Intérêts partagés",
      ),
    ).toBe(true);

    expect(resolution.status).toBe("passed");
    expect(founder.hasEmbargoAgainst(target)).toBe(true);
    expect(allyA.hasEmbargoAgainst(target)).toBe(true);
    expect(allyB.hasEmbargoAgainst(target)).toBe(false);
    expect(target.reputation()).toBe(92);
  });

  it("turns a passed reparations resolution into an ordinary proposal", () => {
    const organization = game.createInternationalOrganization(
      founder,
      "Conseil d’arbitrage",
      [allyA, allyB],
      ["mediate_disputes"],
    )!;
    const incident = game.recordDiplomaticIncident(
      "trade_ship_destroyed",
      target,
      founder,
      400,
    )!;
    const resolution = game.proposeInternationalResolution(
      founder,
      organization.id,
      "demand_reparations",
      target,
      { beneficiaryID: founder.id(), incidentID: incident.id, amount: 400 },
    )!;
    for (const member of [founder, allyA, allyB]) {
      expect(
        game.voteInternationalResolution(
          member,
          resolution.id,
          "for",
          "Preuves confirmées",
        ),
      ).toBe(true);
    }
    expect(resolution.status).toBe("passed");
    expect(game.diplomaticProposalsFor(founder.id())[0]).toMatchObject({
      proposerID: founder.id(),
      recipientID: target.id(),
      terms: [
        {
          kind: "gold_reparations",
          payerID: target.id(),
          recipientID: founder.id(),
          amount: 400,
          incidentID: incident.id,
        },
      ],
    });
  });

  it("produces deterministic explainable AI votes", () => {
    const organization = game.createInternationalOrganization(
      founder,
      "Conseil",
      [allyA, allyB],
      ["oppose_unjustified_wars"],
    )!;
    const incident = game.recordDiplomaticIncident(
      "trade_ship_destroyed",
      target,
      founder,
      250,
    )!;
    const resolution = game.proposeInternationalResolution(
      founder,
      organization.id,
      "condemn",
      target,
      { incidentID: incident.id },
    )!;
    expect(
      evaluateInternationalResolutionVote(game, allyA, resolution),
    ).toEqual(evaluateInternationalResolutionVote(game, allyA, resolution));
    expect(
      evaluateInternationalResolutionVote(game, allyA, resolution).reason,
    ).toContain(":");
  });
});
