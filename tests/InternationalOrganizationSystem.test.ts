import { beforeEach, describe, expect, it, vi } from "vitest";
import { InternationalOrganizationExecution } from "../src/core/execution/InternationalOrganizationExecution";
import {
  CasusBelliType,
  Game,
  Player,
  PlayerInfo,
  PlayerType,
} from "../src/core/game/Game";
import {
  evaluateInternationalResolutionResponse,
  evaluateInternationalResolutionVote,
} from "../src/core/game/InternationalOrganizationRegistry";
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

  it("requires member approval before admitting a new country", () => {
    const organization = game.createInternationalOrganization(
      founder,
      "Union diplomatique",
      [allyA, allyB],
      ["mediate_disputes"],
    )!;
    expect(organization.memberIDs).not.toContain(target.id());
    const application = game.proposeInternationalResolution(
      target,
      organization.id,
      "admit_member",
      target,
    )!;
    expect(application).toMatchObject({
      kind: "admit_member",
      proposerID: target.id(),
      targetID: target.id(),
    });
    expect(
      game.proposeInternationalResolution(
        target,
        organization.id,
        "admit_member",
        target,
      ),
    ).toBeNull();
    for (const member of [founder, allyA, allyB]) {
      game.voteInternationalResolution(
        member,
        application.id,
        "for",
        "Candidature acceptable",
      );
    }
    expect(application.status).toBe("passed");
    expect(organization.memberIDs).toContain(target.id());
    expect(target.reputation()).toBe(100);
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

  it("records compliance without granting an enforcement war goal", () => {
    const organization = game.createInternationalOrganization(
      founder,
      "Conseil de sécurité",
      [allyA, allyB],
      ["oppose_unjustified_wars"],
    )!;
    const resolution = game.proposeInternationalResolution(
      founder,
      organization.id,
      "condemn",
      target,
    )!;
    for (const member of [founder, allyA, allyB]) {
      game.voteInternationalResolution(
        member,
        resolution.id,
        "for",
        "Responsabilité établie",
      );
    }

    expect(resolution.targetResponse).toBe("pending");
    expect(
      game.respondInternationalResolution(
        target,
        resolution.id,
        true,
        "Résolution reconnue",
      ),
    ).toBe(true);
    expect(resolution).toMatchObject({
      targetResponse: "complied",
      targetResponseReason: "Résolution reconnue",
    });
    expect(founder.casusBelliAgainst(target)).toBeNull();
    expect(
      game.respondInternationalResolution(target, resolution.id, false, "Non"),
    ).toBe(false);
  });

  it("turns defiance into an explainable enforcement casus belli", () => {
    const organization = game.createInternationalOrganization(
      founder,
      "Assemblée internationale",
      [allyA, allyB],
      ["collective_sanctions"],
    )!;
    const resolution = game.proposeInternationalResolution(
      founder,
      organization.id,
      "condemn",
      target,
    )!;
    game.voteInternationalResolution(
      founder,
      resolution.id,
      "for",
      "Droit international",
    );
    game.voteInternationalResolution(allyA, resolution.id, "for", "Solidarité");
    game.voteInternationalResolution(
      allyB,
      resolution.id,
      "against",
      "Neutralité",
    );

    expect(
      game.respondInternationalResolution(
        target,
        resolution.id,
        false,
        "Souveraineté nationale",
      ),
    ).toBe(true);
    expect(resolution).toMatchObject({
      targetResponse: "defied",
      targetResponseReason: "Souveraineté nationale",
    });
    expect(founder.casusBelliAgainst(target)?.type).toBe(
      CasusBelliType.EnforceResolution,
    );
    expect(allyA.casusBelliAgainst(target)?.type).toBe(
      CasusBelliType.EnforceResolution,
    );
    expect(allyB.casusBelliAgainst(target)).toBeNull();
    expect(
      founder
        .diplomaticMemories()
        .some(
          (memory) =>
            memory.otherID === target.id() &&
            memory.type === "resolution_ignored",
        ),
    ).toBe(true);
  });

  it("treats an unanswered passed resolution as defiance at its deadline", () => {
    const organization = game.createInternationalOrganization(
      founder,
      "Conseil des États",
      [allyA, allyB],
      ["oppose_unjustified_wars"],
    )!;
    const resolution = game.proposeInternationalResolution(
      founder,
      organization.id,
      "condemn",
      target,
    )!;
    for (const member of [founder, allyA, allyB]) {
      game.voteInternationalResolution(member, resolution.id, "for", "Oui");
    }
    const deadline = resolution.targetResponseDeadline!;
    while (game.ticks() <= deadline) game.executeNextTick();

    expect(resolution).toMatchObject({
      targetResponse: "defied",
      targetResponseReason: "Aucune réponse avant l’échéance",
    });
    expect(founder.casusBelliAgainst(target)?.type).toBe(
      CasusBelliType.EnforceResolution,
    );
  });

  it("produces deterministic explainable AI responses", () => {
    const organization = game.createInternationalOrganization(
      founder,
      "Forum diplomatique",
      [allyA, allyB],
      ["mediate_disputes"],
    )!;
    const resolution = game.proposeInternationalResolution(
      founder,
      organization.id,
      "condemn",
      target,
    )!;
    game.voteInternationalResolution(founder, resolution.id, "for", "Oui");
    game.voteInternationalResolution(allyA, resolution.id, "for", "Oui");
    game.voteInternationalResolution(allyB, resolution.id, "for", "Oui");

    const first = evaluateInternationalResolutionResponse(
      game,
      target,
      resolution,
    );
    expect(first).toEqual(
      evaluateInternationalResolutionResponse(game, target, resolution),
    );
    expect(first.reason).toContain(":");
    expect(Number.isFinite(first.score)).toBe(true);
  });

  it("creates organizations and records votes while paused without advancing time", () => {
    const tick = game.ticks();
    game.setPaused(true);
    game.executePausedActions([
      new InternationalOrganizationExecution(founder, "create", {
        name: "Conseil de pause",
        memberIDs: [allyA.id(), allyB.id()],
        principles: ["mediate_disputes"],
      }),
    ]);
    const organization = game.internationalOrganizations()[0];
    expect(organization.name).toBe("Conseil de pause");
    expect(game.ticks()).toBe(tick);

    const resolution = game.proposeInternationalResolution(
      founder,
      organization.id,
      "condemn",
      target,
    )!;
    game.executePausedActions([
      new InternationalOrganizationExecution(founder, "vote", {
        resolutionID: resolution.id,
        vote: "for",
        reason: "Décision immédiate",
      }),
    ]);
    expect(resolution.votes).toContainEqual({
      voterID: founder.id(),
      choice: "for",
      reason: "Décision immédiate",
    });

    for (const member of [allyA, allyB]) {
      game.voteInternationalResolution(
        member,
        resolution.id,
        "for",
        "Décision immédiate",
      );
    }
    game.executePausedActions([
      new InternationalOrganizationExecution(target, "defy", {
        resolutionID: resolution.id,
        reason: "Refus pendant la pause",
      }),
    ]);
    expect(resolution.targetResponse).toBe("defied");
    expect(game.ticks()).toBe(tick);
  });
});
