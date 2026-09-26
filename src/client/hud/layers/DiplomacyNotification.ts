import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  DiplomaticProposal,
  DiplomaticTerm,
  InternationalResolution,
  TradeContract,
} from "../../../core/game/Game";
import { Controller } from "../../Controller";
import { GameView, PlayerView } from "../../view";

type NoticeTone = "positive" | "negative" | "warning" | "info";

interface DiplomacyNotice {
  id: number;
  title: string;
  body: string;
  icon: string;
  tone: NoticeTone;
  until: number;
}

export function diplomaticTermLabel(terms: readonly DiplomaticTerm[]): string {
  if (terms.some((term) => term.kind === "non_aggression_pact"))
    return "pacte de non-agression";
  if (terms.some((term) => term.kind === "trade_agreement"))
    return "accord commercial";
  if (terms.some((term) => term.kind === "cede_region"))
    return "traité territorial";
  if (terms.some((term) => term.kind === "end_war")) return "offre de paix";
  if (terms.some((term) => term.kind === "gold_reparations"))
    return "demande de réparations";
  if (terms.some((term) => term.kind === "formal_apology"))
    return "demande d’excuses";
  return "proposition diplomatique";
}

function resolutionLabel(resolution: InternationalResolution): string {
  switch (resolution.kind) {
    case "admit_member":
      return "candidature";
    case "collective_sanctions":
      return "sanctions collectives";
    case "demand_reparations":
      return "réparations internationales";
    case "condemn":
      return "condamnation internationale";
  }
}

@customElement("diplomacy-notification")
export class DiplomacyNotification extends LitElement implements Controller {
  public game!: GameView;
  @state() private notices: DiplomacyNotice[] = [];
  private proposalStates = new Map<string, DiplomaticProposal["status"]>();
  private tradeStates = new Map<string, TradeContract["status"]>();
  private incidentStates = new Map<string, string>();
  private resolutionStates = new Map<string, string>();
  private memoryKeys = new Set<string>();
  private allianceRequests = new Set<string>();
  private allies = new Set<string>();
  private casusBelli = new Map<string, string>();
  private ready = false;
  private seq = 1;

  init() {
    this.captureBaseline();
  }

  getTickIntervalMs() {
    return 150;
  }

  tick() {
    if (!this.game || this.game.inSpawnPhase()) return;
    const me = this.game.myPlayer();
    if (!me?.isPlayer()) return;
    if (!this.ready) {
      this.captureBaseline();
      return;
    }

    this.scanProposals(me);
    this.scanTrade(me);
    this.scanIncidents(me);
    this.scanInternationalResolutions(me);
    this.scanAlliances(me);
    this.scanCasusBelli(me);
    this.scanMemories(me);
    const now = Date.now();
    const active = this.notices.filter((notice) => notice.until > now);
    if (active.length !== this.notices.length) this.notices = active;
  }

  private captureBaseline() {
    if (!this.game || this.game.inSpawnPhase()) return;
    const me = this.game.myPlayer();
    if (!me?.isPlayer()) return;
    this.proposalStates = new Map(
      me
        .diplomaticProposals()
        .map((proposal) => [proposal.id, proposal.status]),
    );
    this.tradeStates = new Map(
      me.tradeContracts().map((contract) => [contract.id, contract.status]),
    );
    this.incidentStates = new Map(
      me
        .diplomaticIncidents()
        .map((incident) => [incident.id, incident.status]),
    );
    this.resolutionStates = new Map(
      me
        .internationalResolutions()
        .map((resolution) => [resolution.id, this.resolutionState(resolution)]),
    );
    this.memoryKeys = new Set(
      me.diplomaticMemories().map((memory) => this.memoryKey(memory)),
    );
    this.allianceRequests = this.currentAllianceRequests(me);
    this.allies = new Set(me.allies().map((ally) => ally.id()));
    this.casusBelli = new Map(
      me
        .casusBelli()
        .filter((cb) => cb.expiresAt > this.game.ticks())
        .map((cb) => [cb.targetID, cb.type]),
    );
    this.ready = true;
  }

  private scanProposals(me: PlayerView) {
    const current = new Map<string, DiplomaticProposal["status"]>();
    for (const proposal of me.diplomaticProposals()) {
      current.set(proposal.id, proposal.status);
      const previous = this.proposalStates.get(proposal.id);
      const otherID =
        proposal.proposerID === me.id()
          ? proposal.recipientID
          : proposal.proposerID;
      const country = this.countryName(otherID);
      const subject = diplomaticTermLabel(proposal.terms);
      const mine = proposal.proposerID === me.id();
      if (previous === undefined && proposal.status === "pending") {
        if (mine) {
          this.add(
            "Demande envoyée",
            `${subject} proposé à ${country}.`,
            "📤",
            "info",
          );
        } else {
          this.add(
            proposal.parentProposalID
              ? "Contre-proposition reçue"
              : "Demande diplomatique reçue",
            `${country} propose un ${subject}.`,
            "📜",
            "warning",
          );
        }
        continue;
      }
      if (previous === undefined || previous === proposal.status) continue;
      if (
        proposal.status === "settled" ||
        proposal.status === "accepted_pending_settlement"
      ) {
        if (previous !== "accepted_pending_settlement")
          this.add(
            "Accord accepté",
            `${country} et notre gouvernement ont conclu un ${subject}.`,
            "✅",
            "positive",
          );
      } else if (proposal.status === "rejected") {
        this.add(
          mine ? "Demande refusée" : "Refus transmis",
          mine
            ? `${country} a refusé notre ${subject}.`
            : `Notre gouvernement a refusé le ${subject} de ${country}.`,
          "❌",
          "negative",
        );
      } else if (proposal.status === "countered" && mine) {
        this.add(
          "Négociation poursuivie",
          `${country} prépare une contre-proposition pour le ${subject}.`,
          "↔",
          "warning",
        );
      } else if (
        proposal.status === "expired" ||
        proposal.status === "invalidated" ||
        proposal.status === "withdrawn"
      ) {
        this.add(
          "Négociation terminée",
          `Le ${subject} avec ${country} est ${
            proposal.status === "expired"
              ? "expiré"
              : proposal.status === "withdrawn"
                ? "retiré"
                : "devenu invalide"
          }.`,
          "⌛",
          "negative",
        );
      }
    }
    this.proposalStates = current;
  }

  private scanTrade(me: PlayerView) {
    const current = new Map<string, TradeContract["status"]>();
    for (const contract of me.tradeContracts()) {
      current.set(contract.id, contract.status);
      const previous = this.tradeStates.get(contract.id);
      const selling = contract.sellerID === me.id();
      const partner = this.countryName(
        selling ? contract.buyerID : contract.sellerID,
      );
      const flow = selling ? "exportation vers" : "importation depuis";
      const detail = `${contract.amountPerDelivery} ${contract.resource} · ${flow} ${partner}`;
      if (previous === undefined && contract.status === "active") {
        this.add("Contrat commercial accepté", detail, "📦", "positive");
      } else if (previous !== undefined && previous !== contract.status) {
        const labels: Record<TradeContract["status"], string> = {
          active: "activé",
          completed: "achevé",
          cancelled: "annulé",
          failed: "rompu",
        };
        this.add(
          `Contrat commercial ${labels[contract.status]}`,
          contract.lastFailure
            ? `${detail} · cause : ${contract.lastFailure.replace(/_/g, " ")}`
            : detail,
          contract.status === "completed" ? "✅" : "📦",
          contract.status === "completed" ? "positive" : "negative",
        );
      }
    }
    this.tradeStates = current;
  }

  private scanIncidents(me: PlayerView) {
    const current = new Map<string, string>();
    for (const incident of me.diplomaticIncidents()) {
      current.set(incident.id, incident.status);
      const previous = this.incidentStates.get(incident.id);
      if (previous === undefined) {
        this.add(
          "Incident diplomatique",
          `${this.countryName(incident.offenderID)} est impliqué contre ${this.countryName(incident.victimID)} : ${incident.type.replace(/_/g, " ")}.`,
          "⚠",
          "warning",
        );
      } else if (previous !== incident.status) {
        this.add(
          "Incident mis à jour",
          `${incident.type.replace(/_/g, " ")} : ${incident.status}.`,
          "⚠",
          incident.status === "settled" || incident.status === "dismissed"
            ? "positive"
            : "warning",
        );
      }
    }
    this.incidentStates = current;
  }

  private scanInternationalResolutions(me: PlayerView) {
    const current = new Map<string, string>();
    for (const resolution of me.internationalResolutions()) {
      const state = this.resolutionState(resolution);
      current.set(resolution.id, state);
      const previous = this.resolutionStates.get(resolution.id);
      const label = resolutionLabel(resolution);
      if (previous === undefined && resolution.status === "voting") {
        this.add(
          "Nouveau vote international",
          `${label} concernant ${this.countryName(resolution.targetID)}.`,
          "🌐",
          "warning",
        );
      } else if (
        previous !== undefined &&
        previous.split(":", 1)[0] !== resolution.status
      ) {
        this.add(
          resolution.status === "passed"
            ? "Résolution adoptée"
            : "Résolution rejetée",
          `${label} concernant ${this.countryName(resolution.targetID)}.`,
          "🌐",
          resolution.status === "passed" ? "positive" : "negative",
        );
      } else if (previous !== undefined && previous !== state) {
        if (resolution.targetResponse === "complied") {
          this.add(
            "Résolution respectée",
            `${this.countryName(resolution.targetID)} accepte la ${label}.`,
            "🌐",
            "positive",
          );
        } else if (resolution.targetResponse === "defied") {
          this.add(
            "Résolution ignorée",
            `${this.countryName(resolution.targetID)} refuse la ${label}. Un motif de guerre est accordé aux soutiens.`,
            "⚠",
            "negative",
          );
        }
      }
    }
    this.resolutionStates = current;
  }

  private resolutionState(resolution: InternationalResolution): string {
    return `${resolution.status}:${resolution.targetResponse ?? ""}`;
  }

  private scanAlliances(me: PlayerView) {
    const requests = this.currentAllianceRequests(me);
    for (const request of requests) {
      if (this.allianceRequests.has(request)) continue;
      const [senderID, recipientID] = request.split("→");
      if (recipientID === me.id())
        this.add(
          "Demande d’alliance",
          `${this.countryName(senderID)} propose une alliance.`,
          "🤝",
          "warning",
        );
      else
        this.add(
          "Demande d’alliance envoyée",
          `Proposition transmise à ${this.countryName(recipientID)}.`,
          "🤝",
          "info",
        );
    }
    const allies = new Set(me.allies().map((ally) => ally.id()));
    for (const allyID of allies) {
      if (!this.allies.has(allyID))
        this.add(
          "Alliance acceptée",
          `${this.countryName(allyID)} est désormais notre allié.`,
          "🤝",
          "positive",
        );
    }
    for (const request of this.allianceRequests) {
      if (requests.has(request)) continue;
      const [senderID, recipientID] = request.split("→");
      const otherID = senderID === me.id() ? recipientID : senderID;
      if (!allies.has(otherID) && senderID === me.id())
        this.add(
          "Alliance refusée ou expirée",
          `${this.countryName(otherID)} n’a pas accepté notre demande.`,
          "❌",
          "negative",
        );
    }
    this.allianceRequests = requests;
    this.allies = allies;
  }

  private scanCasusBelli(me: PlayerView) {
    const current = new Map<string, string>();
    for (const cb of me.casusBelli()) {
      if (cb.expiresAt <= this.game.ticks()) continue;
      current.set(cb.targetID, cb.type);
      if (!this.casusBelli.has(cb.targetID) && cb.type !== "containment")
        this.add(
          "Casus belli obtenu",
          `${cb.type === "enforce_resolution" ? "Faire respecter la résolution" : cb.type.replace(/_/g, " ")} contre ${this.countryName(cb.targetID)}.`,
          "⚖",
          "warning",
        );
    }
    this.casusBelli = current;
  }

  private scanMemories(me: PlayerView) {
    const current = new Set<string>();
    for (const memory of me.diplomaticMemories()) {
      const key = this.memoryKey(memory);
      current.add(key);
      if (!this.memoryKeys.has(key) && memory.type === "trade_offer_refused")
        this.add(
          "Offre commerciale refusée",
          `${this.countryName(memory.otherID)} a refusé nos conditions commerciales.`,
          "❌",
          "negative",
        );
    }
    this.memoryKeys = current;
  }

  private currentAllianceRequests(me: PlayerView): Set<string> {
    const requests = new Set<string>();
    for (const player of this.game.players()) {
      if (player.isRequestingAllianceWith(me))
        requests.add(`${player.id()}→${me.id()}`);
      if (me.isRequestingAllianceWith(player))
        requests.add(`${me.id()}→${player.id()}`);
    }
    return requests;
  }

  private memoryKey(
    memory: ReturnType<PlayerView["diplomaticMemories"]>[number],
  ) {
    return `${memory.otherID}:${memory.type}:${memory.createdAt}:${memory.occurrences}`;
  }

  private countryName(id: string): string {
    try {
      return this.game.player(id).displayName();
    } catch {
      return id;
    }
  }

  private add(title: string, body: string, icon: string, tone: NoticeTone) {
    this.notices = [
      ...this.notices,
      { id: this.seq++, title, body, icon, tone, until: Date.now() + 8500 },
    ].slice(-5);
  }

  render() {
    const toneClass: Record<NoticeTone, string> = {
      positive: "border-emerald-400 text-emerald-300",
      negative: "border-red-400 text-red-300",
      warning: "border-amber-400 text-amber-300",
      info: "border-sky-400 text-sky-300",
    };
    return html`<div
      class="pointer-events-none fixed right-4 top-28 z-[1100] flex w-[390px] max-w-[calc(100vw-32px)] flex-col gap-2"
      aria-live="polite"
    >
      ${this.notices.map(
        (notice) =>
          html`<div
            class=${`pointer-events-auto rounded-lg border bg-zinc-950/95 px-3 py-2 text-zinc-100 shadow-2xl ${toneClass[notice.tone]}`}
          >
            <div class="text-xs font-black">${notice.icon} ${notice.title}</div>
            <div class="mt-1 text-xs text-zinc-100">${notice.body}</div>
          </div>`,
      )}
    </div>`;
  }

  createRenderRoot() {
    return this;
  }
}
