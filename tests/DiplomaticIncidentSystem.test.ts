import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiplomaticIncidentExecution } from "../src/core/execution/DiplomaticIncidentExecution";
import { chooseDiplomaticInitiative } from "../src/core/game/DiplomaticInitiative";
import { evaluateDiplomaticProposal } from "../src/core/game/DiplomaticProposalEvaluation";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let victim: Player;
let offender: Player;

beforeEach(async () => {
  game = await setup("plains", {}, [
    new PlayerInfo("Victim", PlayerType.Human, "victim", "victim"),
    new PlayerInfo("Offender", PlayerType.Nation, null, "offender"),
  ]);
  victim = game.player("victim");
  offender = game.player("offender");
  victim.conquer(game.ref(50, 50));
  offender.conquer(game.ref(50, 51));
  offender.addGold(2_000n);
  vi.spyOn(game, "ticksSinceStart").mockReturnValue(300);
});

describe("diplomatic incidents", () => {
  it("records a confirmed seizure and its persistent grievance", () => {
    const trust = victim.trust(offender);
    const incident = game.recordDiplomaticIncident(
      "trade_ship_seized",
      offender,
      victim,
      450,
      42,
    )!;
    expect(incident).toMatchObject({
      offenderID: offender.id(),
      victimID: victim.id(),
      damages: 450,
      evidence: "confirmed",
      status: "unresolved",
      sourceUnitID: 42,
    });
    expect(victim.trust(offender)).toBeLessThan(trust);
    expect(
      victim
        .diplomaticMemories()
        .some((memory) => memory.type === "trade_ship_seized"),
    ).toBe(true);
    expect(game.diplomaticIncidentsFor(victim.id())).toEqual([incident]);
  });

  it("aggregates repeated seizures between the same countries", () => {
    const first = game.recordDiplomaticIncident(
      "trade_ship_seized",
      offender,
      victim,
      100,
      10,
    )!;
    const repeated = game.recordDiplomaticIncident(
      "trade_ship_seized",
      offender,
      victim,
      75,
      11,
    )!;
    game.updateDiplomaticIncidentDamages(first.id, 25);

    expect(repeated.id).toBe(first.id);
    expect(repeated.damages).toBe(200);
    expect(repeated.severity).toBeGreaterThan(50);
    expect(repeated.sourceUnitID).toBe(11);
    expect(game.diplomaticIncidentsFor(victim.id())).toHaveLength(1);
  });

  it("ignores piracy involving a tribe", async () => {
    const tribeGame = await setup("plains", {}, [
      new PlayerInfo("Human", PlayerType.Human, "human", "human"),
      new PlayerInfo("Tribe", PlayerType.Bot, null, "tribe"),
    ]);
    expect(
      tribeGame.recordDiplomaticIncident(
        "trade_ship_seized",
        tribeGame.player("tribe"),
        tribeGame.player("human"),
        100,
      ),
    ).toBeNull();
  });

  it("allows a protest during pause without advancing time", () => {
    const incident = game.recordDiplomaticIncident(
      "trade_ship_seized",
      offender,
      victim,
      300,
    )!;
    const ticks = game.ticks();
    game.executePausedActions([
      new DiplomaticIncidentExecution(victim, "protest", incident.id),
    ]);
    expect(game.ticks()).toBe(ticks);
    expect(incident.status).toBe("protested");
  });

  it("settles incident reparations without requiring a war", () => {
    const incident = game.recordDiplomaticIncident(
      "trade_ship_seized",
      offender,
      victim,
      500,
    )!;
    const victimGold = victim.gold();
    const result = game.createDiplomaticProposal(victim, offender, [
      {
        kind: "gold_reparations",
        payerID: offender.id(),
        recipientID: victim.id(),
        amount: 500,
        incidentID: incident.id,
      },
    ]);
    expect(result.accepted).toBe(true);
    expect(incident.status).toBe("negotiating");
    game.acceptDiplomaticProposal(offender, result.proposal!.id);
    game.executeNextTick();
    expect(result.proposal!.status).toBe("settled");
    expect(incident.status).toBe("settled");
    expect(incident.settlementAmount).toBe(500);
    expect(victim.gold()).toBe(victimGold + 500n);
  });

  it("gives an AI victim one explainable reparations initiative", () => {
    const incident = game.recordDiplomaticIncident(
      "trade_ship_seized",
      offender,
      victim,
      350,
    )!;
    game.protestDiplomaticIncident(victim, incident.id);

    const initiative = chooseDiplomaticInitiative(game, victim);
    expect(initiative).toMatchObject({
      targetID: offender.id(),
      terms: [
        {
          kind: "gold_reparations",
          payerID: offender.id(),
          recipientID: victim.id(),
          amount: 350,
          incidentID: incident.id,
        },
      ],
      reasons: [{ code: "unresolved_incident", impact: 50 }],
    });

    const created = game.createDiplomaticProposal(
      victim,
      offender,
      initiative!.terms,
      undefined,
      initiative!.reasons,
    );
    const proposal = game.diplomaticProposalsFor(victim.id())[0];
    const evaluation = evaluateDiplomaticProposal(game, offender, proposal);
    expect(evaluation.decision).toBe("accept");
    expect(
      evaluation.reasons.some((reason) => reason.code === "confirmed_incident"),
    ).toBe(true);
    expect(chooseDiplomaticInitiative(game, victim)).toBeNull();
    game.rejectDiplomaticProposal(offender, created.proposal!.id);
    expect(chooseDiplomaticInitiative(game, victim)).toBeNull();
  });

  it("rejects excessive demands and escalates a refused valid demand", () => {
    const incident = game.recordDiplomaticIncident(
      "trade_ship_seized",
      offender,
      victim,
      200,
    )!;
    const excessive = game.createDiplomaticProposal(victim, offender, [
      {
        kind: "gold_reparations",
        payerID: offender.id(),
        recipientID: victim.id(),
        amount: 500,
        incidentID: incident.id,
      },
    ]);
    expect(excessive.accepted).toBe(false);
    expect(
      excessive.reasons.some(
        (reason) => reason.code === "reparations_exceed_damages",
      ),
    ).toBe(true);

    const valid = game.createDiplomaticProposal(victim, offender, [
      {
        kind: "gold_reparations",
        payerID: offender.id(),
        recipientID: victim.id(),
        amount: 300,
        incidentID: incident.id,
      },
    ]).proposal!;
    game.rejectDiplomaticProposal(offender, valid.id);
    expect(incident.status).toBe("escalated");
    expect(
      victim
        .diplomaticMemories()
        .some((memory) => memory.type === "reparations_refused"),
    ).toBe(true);
  });
});
