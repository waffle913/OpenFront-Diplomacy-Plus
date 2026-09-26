import { Execution, Game, WORLD_FORMATION_UNLOCK_TICK } from "../game/Game";
import { PseudoRandom } from "../PseudoRandom";
import { ClientID, GameID, StampedIntent, Turn } from "../Schemas";
import { simpleHash } from "../Util";
import { AllianceExtensionExecution } from "./alliance/AllianceExtensionExecution";
import { AllianceRejectExecution } from "./alliance/AllianceRejectExecution";
import { AllianceRequestExecution } from "./alliance/AllianceRequestExecution";
import { BreakAllianceExecution } from "./alliance/BreakAllianceExecution";
import { AttackExecution } from "./AttackExecution";
import { BoatRetreatExecution } from "./BoatRetreatExecution";
import { ConstructionExecution } from "./ConstructionExecution";
import { DeleteUnitExecution } from "./DeleteUnitExecution";
import { DiplomacyPlusExecution } from "./DiplomacyPlusExecution";
import { DiplomaticIncidentExecution } from "./DiplomaticIncidentExecution";
import { DiplomaticProposalExecution } from "./DiplomaticProposalExecution";
import { DomesticPolicyExecution } from "./DomesticPolicyExecution";
import { DonateGoldExecution } from "./DonateGoldExecution";
import { DonateTroopsExecution } from "./DonateTroopExecution";
import { EmbargoAllExecution } from "./EmbargoAllExecution";
import { EmbargoExecution } from "./EmbargoExecution";
import { EmojiExecution } from "./EmojiExecution";
import { InternationalOrganizationExecution } from "./InternationalOrganizationExecution";
import { MarkDisconnectedExecution } from "./MarkDisconnectedExecution";
import { MobilizationPolicyExecution } from "./MobilizationPolicyExecution";
import { MoveWarshipExecution } from "./MoveWarshipExecution";
import { NationExecution } from "./NationExecution";
import { NoOpExecution } from "./NoOpExecution";
import { PauseExecution } from "./PauseExecution";
import { QuickChatExecution } from "./QuickChatExecution";
import { RetreatExecution } from "./RetreatExecution";
import { SpawnExecution } from "./SpawnExecution";
import { TargetPlayerExecution } from "./TargetPlayerExecution";
import { TradeExecution } from "./TradeExecution";
import { TransportShipExecution } from "./TransportShipExecution";
import { TribeSpawner } from "./TribeSpawner";
import { UpgradeStructureExecution } from "./UpgradeStructureExecution";
import { PlayerSpawner } from "./utils/PlayerSpawner";

export class Executor {
  // private random = new PseudoRandom(999)
  private random: PseudoRandom;

  constructor(
    private mg: Game,
    private gameID: GameID,
    private clientID: ClientID | undefined,
    // Purchased bot tribe names drawn for this game (GameStartInfo.tribes).
    private purchasedTribeNames: string[] = [],
  ) {
    // Add one to avoid id collisions with tribes.
    this.random = new PseudoRandom(simpleHash(gameID) + 1);
  }

  createExecs(turn: Turn): Execution[] {
    return turn.intents.map((i) => this.createExec(i));
  }

  createExec(intent: StampedIntent): Execution {
    const player = this.mg.playerByClientID(intent.clientID);
    if (!player) {
      console.warn(`player with clientID ${intent.clientID} not found`);
      return new NoOpExecution();
    }

    // create execution
    switch (intent.type) {
      case "attack": {
        if (
          !this.mg.inSpawnPhase() &&
          this.mg.ticksSinceStart() < WORLD_FORMATION_UNLOCK_TICK &&
          intent.targetID !== null &&
          this.mg.hasPlayer(intent.targetID)
        ) {
          return new NoOpExecution();
        }
        return new AttackExecution(
          intent.troops,
          player,
          intent.targetID,
          null,
          true,
          intent.targetTile === null || intent.targetTile === undefined
            ? null
            : (this.mg.historicalRegionAt(intent.targetTile)?.id ?? null),
        );
      }
      case "cancel_attack":
        return new RetreatExecution(player, intent.attackID);
      case "cancel_boat":
        return new BoatRetreatExecution(player, intent.unitID);
      case "move_warship":
        return new MoveWarshipExecution(player, intent.unitIds, intent.tile);
      case "spawn":
        // fromIntent: this one came off the wire, so it is subject to the
        // spawn-phase gate that internal spawns are not.
        return new SpawnExecution(
          this.gameID,
          player.info(),
          intent.tile,
          true,
        );
      case "boat": {
        if (
          !this.mg.inSpawnPhase() &&
          this.mg.ticksSinceStart() < WORLD_FORMATION_UNLOCK_TICK &&
          this.mg.hasOwner(intent.dst)
        ) {
          const dstOwner = this.mg.owner(intent.dst);
          if (dstOwner.isPlayer() && dstOwner !== player)
            return new NoOpExecution();
        }
        return new TransportShipExecution(player, intent.dst, intent.troops);
      }
      case "allianceRequest":
        return new AllianceRequestExecution(player, intent.recipient);
      case "allianceReject":
        return new AllianceRejectExecution(intent.requestor, player);
      case "breakAlliance":
        return new BreakAllianceExecution(player, intent.recipient);
      case "targetPlayer":
        return new TargetPlayerExecution(player, intent.target);
      case "emoji":
        return new EmojiExecution(player, intent.recipient, intent.emoji);
      case "donate_troops":
        return new DonateTroopsExecution(
          player,
          intent.recipient,
          intent.troops,
        );
      case "donate_gold":
        return new DonateGoldExecution(player, intent.recipient, intent.gold);
      case "embargo":
        return new EmbargoExecution(player, intent.targetID, intent.action);
      case "diplomacy_plus":
        return new DiplomacyPlusExecution(
          player,
          intent.targetID,
          intent.action,
        );
      case "diplomatic_proposal":
        return new DiplomaticProposalExecution(
          player,
          intent.action,
          intent.targetID,
          intent.proposalID,
          intent.terms,
        );
      case "diplomatic_incident":
        return new DiplomaticIncidentExecution(
          player,
          intent.action,
          intent.incidentID,
        );
      case "international_organization":
        return new InternationalOrganizationExecution(player, intent.action, {
          name: intent.name,
          memberIDs: intent.memberIDs,
          principles: intent.principles,
          organizationID: intent.organizationID,
          resolutionID: intent.resolutionID,
          resolutionKind: intent.resolutionKind,
          targetID: intent.targetID,
          beneficiaryID: intent.beneficiaryID,
          incidentID: intent.incidentID,
          amount: intent.amount,
          vote: intent.vote,
          reason: intent.reason,
        });
      case "trade":
        return new TradeExecution(
          player,
          intent.targetID,
          intent.action,
          intent.direction,
          intent.resource,
          intent.amount,
          intent.price,
          intent.deliveries,
          intent.contractID,
        );
      case "domestic_policy":
        return new DomesticPolicyExecution(player, intent.taxPolicy);
      case "military_mobilization":
        return new MobilizationPolicyExecution(player, intent.percent);
      case "embargo_all":
        return new EmbargoAllExecution(player, intent.action);
      case "build_unit":
        return new ConstructionExecution(
          player,
          intent.unit,
          intent.tile,
          intent.rocketDirectionUp,
          intent.amount,
        );
      case "allianceExtension": {
        return new AllianceExtensionExecution(player, intent.recipient);
      }

      case "upgrade_structure":
        return new UpgradeStructureExecution(
          player,
          intent.unitId,
          intent.amount,
        );
      case "delete_unit":
        return new DeleteUnitExecution(player, intent.unitId);
      case "quick_chat":
        return new QuickChatExecution(
          player,
          intent.recipient,
          intent.quickChatKey,
          intent.target,
        );
      case "mark_disconnected":
        return new MarkDisconnectedExecution(player, intent.isDisconnected);
      case "toggle_pause":
        return new PauseExecution(player, intent.paused);
      default:
        throw new Error(`intent type ${intent} not found`);
    }
  }

  spawnTribes(numTribes: number): SpawnExecution[] {
    const nationCells = this.mg
      .nations()
      .map((n) => n.spawnCell)
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    return new TribeSpawner(this.mg, this.gameID, nationCells).spawnTribes(
      numTribes,
      this.purchasedTribeNames,
    );
  }

  spawnPlayers(): SpawnExecution[] {
    return new PlayerSpawner(this.mg, this.gameID).spawnPlayers();
  }

  nationExecutions(): Execution[] {
    const execs: Execution[] = [];
    for (const nation of this.mg.nations()) {
      execs.push(new NationExecution(this.gameID, nation));
    }
    return execs;
  }
}
