import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { UnitType } from "../../../core/game/Game";
import {
  formatWorldDate,
  formatWorldDeadline,
} from "../../../core/game/WorldCalendar";
import { Controller } from "../../Controller";
import {
  SendDiplomacyPlusIntentEvent,
  SendDomesticPolicyIntentEvent,
  SendEmbargoIntentEvent,
  SendMobilizationIntentEvent,
  SendTradeIntentEvent,
} from "../../Transport";
import { GameView, PlayerView } from "../../view";
import { ShowHistoricalRegionEvent } from "./HistoricalRegionPanel";

type CountryMenuTab =
  | "country"
  | "economy"
  | "armies"
  | "diplomacy"
  | "trade"
  | "crises"
  | "government";

const MENU_TABS: { id: CountryMenuTab; icon: string; label: string }[] = [
  { id: "country", icon: "🏛", label: "Pays" },
  { id: "economy", icon: "💰", label: "Fiscalité" },
  { id: "armies", icon: "⚔", label: "Armées" },
  { id: "diplomacy", icon: "🤝", label: "Diplomatie" },
  { id: "trade", icon: "📦", label: "Commerce" },
  { id: "crises", icon: "⚠", label: "Crises" },
  { id: "government", icon: "👑", label: "Gouvernement" },
];

@customElement("diplomacy-panel")
export class DiplomacyPanel extends LitElement implements Controller {
  @property({ attribute: false }) public game!: GameView;
  @property({ attribute: false }) public eventBus!: EventBus;
  @state() public isVisible = false;
  @state() private selectedID: string | null = null;
  private lastForeignID: string | null = null;
  @state() private activeTab: CountryMenuTab = "country";
  @state() private countrySearch = "";
  @state() private tradeResource: "food" | "materials" | "fuel" = "food";
  @state() private tradeAmount = 25;
  @state() private tradePrice = 250;
  @state() private tradeDeliveries = 3;

  createRenderRoot() {
    return this;
  }
  init() {}
  getTickIntervalMs() {
    return 250;
  }
  tick() {
    if (this.isVisible) this.requestUpdate();
  }

  show(player: PlayerView) {
    this.selectedID = player.id();
    if (player === this.safeMyPlayer()) {
      this.activeTab = "country";
    } else {
      this.lastForeignID = player.id();
      this.activeTab = "diplomacy";
    }
    this.isVisible = true;
    this.requestUpdate();
  }

  hide() {
    this.isVisible = false;
    this.requestUpdate();
  }

  private safeMyPlayer(): PlayerView | null {
    try {
      return this.game?.myPlayer() ?? null;
    } catch {
      return null;
    }
  }

  private selected(): PlayerView | null {
    const fallback = this.safeMyPlayer();
    if (!this.selectedID) return fallback;
    try {
      return this.game.player(this.selectedID);
    } catch {
      return fallback;
    }
  }

  private openTab(tab: CountryMenuTab) {
    this.activeTab = tab;
    const my = this.safeMyPlayer();
    if ((tab === "economy" || tab === "armies" || tab === "government") && my)
      this.selectedID = my.id();
    else if (
      (tab === "diplomacy" || tab === "trade" || tab === "crises") &&
      this.selectedID === my?.id() &&
      this.lastForeignID
    )
      this.selectedID = this.lastForeignID;
    else if (!this.selectedID && my) this.selectedID = my.id();
    this.isVisible = true;
    this.requestUpdate();
  }

  private deadline(expiresAt: number): string {
    return formatWorldDeadline(
      expiresAt,
      this.game.ticks(),
      this.game.ticksSinceStart(),
    );
  }

  private relationLabel(my: PlayerView, other: PlayerView): string {
    if (my === other) return "Notre pays";
    if (my.isAlliedWith(other)) return "Allié";
    if (my.hasEmbargo(other)) return "Sous embargo";
    if (my.targets().some((candidate) => candidate.id() === other.id()))
      return "Hostile";
    const relation = other
      .diplomaticRelations()
      .find((candidate) => candidate.otherID === my.id());
    if ((relation?.opinion ?? 0) >= 50) return "Amical";
    if ((relation?.opinion ?? 0) < 0) return "Méfiant";
    return "Neutre";
  }

  private navBar(compact = false) {
    if (compact) {
      return html`<button
        class="pointer-events-auto fixed bottom-4 left-4 z-[10020] flex items-center gap-2 rounded-lg border border-amber-500/60 bg-slate-950/95 px-4 py-3 text-xs font-black uppercase tracking-wider text-amber-100 shadow-2xl transition hover:border-amber-300 hover:bg-amber-900/95"
        title="Ouvrir les menus de gestion nationale"
        aria-label="Ouvrir les menus de gestion nationale"
        @click=${() => this.openTab(this.activeTab)}
      >
        <span class="text-base" aria-hidden="true">🏛</span>
        <span>Gestion</span>
      </button>`;
    }

    return html`<nav
      class="flex border-b border-amber-500/30 bg-slate-950/80"
      aria-label="Gestion nationale"
    >
      ${MENU_TABS.map(
        (tab) =>
          html`<button
            role="tab"
            aria-selected=${this.activeTab === tab.id && this.isVisible}
            class=${`min-w-[112px] border-r border-white/10 px-4 py-3 text-xs font-bold uppercase tracking-wide transition ${this.activeTab === tab.id && this.isVisible ? "bg-amber-700 text-white" : "text-slate-300 hover:bg-white/10"}`}
            title=${tab.label}
            @click=${() => this.openTab(tab.id)}
          >
            <span class="mr-1">${tab.icon}</span>${tab.label}
          </button>`,
      )}
    </nav>`;
  }

  render() {
    if (!this.game) return html``;
    const my = this.safeMyPlayer();
    if (!my) return html``;
    if (!this.isVisible) return this.navBar(true);
    const selected = this.selected() ?? my;
    const countries = this.game
      .players()
      .filter(
        (player) =>
          player.isAlive() &&
          player
            .displayName()
            .toLocaleLowerCase()
            .includes(this.countrySearch.toLocaleLowerCase()),
      )
      .sort((a, b) =>
        a === my
          ? -1
          : b === my
            ? 1
            : a.displayName().localeCompare(b.displayName()),
      );

    return html` <style>
        .eu4-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .eu4-scrollbar::-webkit-scrollbar-thumb {
          background: #795c2d;
          border-radius: 8px;
        }
        .eu4-card {
          border: 1px solid rgba(217, 169, 91, 0.28);
          background: rgba(15, 23, 42, 0.82);
          border-radius: 0.5rem;
          padding: 0.75rem;
        }
        .eu4-title {
          color: #f5d78e;
          font-weight: 800;
          font-size: 0.72rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        .eu4-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 0.75rem;
          padding: 0.22rem 0;
        }
        .eu4-action {
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 0.4rem;
          padding: 0.55rem 0.65rem;
          font-size: 0.72rem;
          font-weight: 700;
          background: rgba(30, 41, 59, 0.9);
          text-align: left;
        }
        .eu4-action:hover {
          background: rgba(51, 65, 85, 0.95);
          border-color: rgba(245, 215, 142, 0.55);
        }
      </style>
      <div class="pointer-events-none fixed inset-0 z-[10020]">
        <section
          class="pointer-events-auto absolute inset-x-4 top-4 bottom-4 flex max-w-[1180px] flex-col overflow-hidden rounded-xl border-2 border-amber-600/50 bg-slate-950/97 text-slate-100 shadow-2xl"
          @contextmenu=${(event: MouseEvent) => event.preventDefault()}
          @wheel=${(event: MouseEvent) => event.stopPropagation()}
        >
          <header
            class="flex items-center justify-between border-b border-amber-500/30 bg-gradient-to-r from-slate-900 via-amber-950/40 to-slate-900 px-4 py-3"
          >
            <div>
              <div
                class="text-[10px] font-black tracking-[.24em] text-amber-300"
              >
                CONSEIL D'ÉTAT
              </div>
              <div class="text-xl font-black">${my.displayName()}</div>
            </div>
            <div class="flex items-center gap-5 text-xs">
              <span
                >💰
                <b>${Math.floor(Number(my.gold())).toLocaleString()}</b></span
              >
              <span>👥 <b>${Math.floor(my.troops()).toLocaleString()}</b></span>
              <span
                >📅 <b>${formatWorldDate(this.game.ticksSinceStart())}</b></span
              >
              <button
                class="rounded bg-red-900/80 px-3 py-2 font-bold hover:bg-red-800"
                @click=${() => this.hide()}
              >
                ✕
              </button>
            </div>
          </header>
          ${this.navBar()}
          <div
            class="grid min-h-0 flex-1 grid-cols-[230px_minmax(0,1fr)_280px]"
          >
            <aside
              class="eu4-scrollbar overflow-y-auto border-r border-amber-500/25 bg-slate-900/75 p-3"
            >
              <input
                class="mb-3 w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs outline-none focus:border-amber-500"
                placeholder="Rechercher un pays…"
                .value=${this.countrySearch}
                @input=${(event: Event) => {
                  this.countrySearch = (event.target as HTMLInputElement).value;
                }}
              />
              ${countries.map((country) => {
                const relation = country
                  .diplomaticRelations()
                  .find((item) => item.otherID === my.id());
                return html`<button
                  class=${`mb-1 w-full rounded border px-3 py-2 text-left ${country === selected ? "border-amber-400 bg-amber-900/50" : "border-white/5 bg-white/5 hover:bg-white/10"}`}
                  @click=${() => {
                    this.selectedID = country.id();
                    if (country !== my) this.lastForeignID = country.id();
                  }}
                >
                  <div
                    class="flex items-center justify-between gap-2 text-xs font-bold"
                  >
                    <span class="truncate"
                      >${country === my
                        ? "★ "
                        : ""}${country.displayName()}</span
                    ><span
                      class=${(relation?.opinion ?? 0) >= 0
                        ? "text-emerald-300"
                        : "text-red-300"}
                      >${Math.round(relation?.opinion ?? 0)}</span
                    >
                  </div>
                  <div class="mt-1 text-[10px] text-slate-400">
                    ${this.relationLabel(my, country)}
                  </div>
                </button>`;
              })}
            </aside>
            <main class="eu4-scrollbar overflow-y-auto p-4">
              ${this.renderActiveTab(my, selected)}
            </main>
            <aside
              class="eu4-scrollbar overflow-y-auto border-l border-amber-500/25 bg-slate-900/75 p-3"
            >
              ${this.renderContextActions(my, selected)}
            </aside>
          </div>
        </section>
      </div>`;
  }

  private renderActiveTab(my: PlayerView, selected: PlayerView) {
    if (this.activeTab === "economy") return this.renderEconomy(my);
    if (this.activeTab === "armies") return this.renderArmies(my);
    if (this.activeTab === "diplomacy")
      return this.renderDiplomacy(my, selected);
    if (this.activeTab === "trade") return this.renderTrade(my, selected);
    if (this.activeTab === "crises") return this.renderCrises(my, selected);
    if (this.activeTab === "government") return this.renderGovernment(my);
    return this.renderCountry(selected);
  }

  private renderCountry(player: PlayerView) {
    const interests = player.nationalInterests();
    const regions = this.game
      .historicalRegions()
      .map((region) => ({
        region,
        control:
          region.controllers?.find((item) => item.playerID === player.id()) ??
          null,
      }))
      .filter((item) => (item.control?.share ?? 0) > 0)
      .sort((a, b) => (b.control?.share ?? 0) - (a.control?.share ?? 0));
    return html` <div
        class="mb-4 flex items-end justify-between border-b border-amber-500/25 pb-3"
      >
        <div>
          <div class="eu4-title">Dossier national</div>
          <h2 class="text-2xl font-black">${player.displayName()}</h2>
        </div>
        <span class="rounded bg-slate-800 px-3 py-1 text-xs"
          >${player.governmentProfile().style.toUpperCase()}</span
        >
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="eu4-card">
          <div class="eu4-title mb-2">Puissance nationale</div>
          <div class="eu4-row">
            <span>Trésor</span
            ><b>${Math.floor(Number(player.gold())).toLocaleString()} or</b>
          </div>
          <div class="eu4-row">
            <span>Armée</span
            ><b>${Math.floor(player.troops()).toLocaleString()}</b>
          </div>
          <div class="eu4-row">
            <span>Stabilité</span><b>${Math.round(player.stability())}/100</b>
          </div>
          <div class="eu4-row">
            <span>Satisfaction</span
            ><b>${Math.round(player.publicSatisfaction())}/100</b>
          </div>
          <div class="eu4-row">
            <span>Réputation</span><b>${Math.round(player.reputation())}/100</b>
          </div>
          <div class="eu4-row">
            <span>Menace</span><b>${Math.round(player.threat())}/100</b>
          </div>
        </div>
        <div class="eu4-card">
          <div class="eu4-title mb-2">Intérêts</div>
          <div class="eu4-row">
            <span>Sécurité</span><b>${interests.security}/100</b>
          </div>
          <div class="eu4-row">
            <span>Expansion</span><b>${interests.expansion}/100</b>
          </div>
          <div class="eu4-row">
            <span>Ressource recherchée</span
            ><b>${interests.resourceAccess.toUpperCase()}</b>
          </div>
          <div class="mt-2 text-xs text-slate-400">
            Partenaires privilégiés :
            ${interests.preferredPartners.length
              ? interests.preferredPartners
                  .map((id) => this.playerName(id))
                  .join(", ")
              : "aucun"}
          </div>
        </div>
      </div>
      <div class="eu4-card mt-3">
        <div class="eu4-title mb-2">Régions contrôlées</div>
        ${regions.length
          ? regions.map(
              ({ region, control }) =>
                html`<button
                  class="eu4-row w-full rounded px-2 text-left hover:bg-white/5"
                  @click=${() =>
                    this.eventBus.emit(
                      new ShowHistoricalRegionEvent(region.id),
                    )}
                >
                  <span>🗺 ${region.name}</span
                  ><b>${Math.round((control?.share ?? 0) * 100)}%</b>
                </button>`,
            )
          : html`<div class="text-sm text-slate-500">
              Aucune région historique contrôlée.
            </div>`}
      </div>`;
  }

  private renderEconomy(my: PlayerView) {
    const shortages = my.resourceShortages();
    const resources = [
      {
        icon: "🌾",
        label: "Nourriture",
        stock: my.food(),
        production: my.foodProduction(),
        consumption: my.foodConsumption(),
        shortage: shortages.food,
      },
      {
        icon: "🧱",
        label: "Matériaux",
        stock: my.materials(),
        production: my.materialsProduction(),
        consumption: my.materialsConsumption(),
        shortage: shortages.materials,
      },
      {
        icon: "⛽",
        label: "Carburant",
        stock: my.fuel(),
        production: my.fuelProduction(),
        consumption: my.fuelConsumption(),
        shortage: shortages.fuel,
      },
    ];
    return html`<div class="eu4-title">Administration du royaume</div>
      <h2 class="mb-4 text-2xl font-black">Fiscalité et économie</h2>
      <div class="grid grid-cols-3 gap-3">
        ${resources.map((resource) => {
          const net = resource.production - resource.consumption;
          return html`<div
            class=${`eu4-card ${resource.shortage ? "border-red-500/70" : ""}`}
          >
            <div class="text-lg font-bold">
              ${resource.icon} ${resource.label}
            </div>
            <div class="mt-2 text-2xl font-black">
              ${resource.stock.toFixed(1)}
            </div>
            <div class=${net >= 0 ? "text-emerald-300" : "text-red-300"}>
              ${net >= 0 ? "+" : ""}${net.toFixed(1)} / mois
            </div>
            <div class="mt-2 text-[10px] text-slate-400">
              Production ${resource.production.toFixed(1)} · Consommation
              ${resource.consumption.toFixed(1)}
            </div>
          </div>`;
        })}
      </div>
      <div class="eu4-card mt-4">
        <div class="eu4-title mb-3">Politique fiscale</div>
        <div class="grid grid-cols-5 gap-2">
          ${(["very_low", "low", "normal", "high", "very_high"] as const).map(
            (policy) =>
              html`<button
                class=${`rounded border p-3 text-left ${my.taxPolicy() === policy ? "border-amber-400 bg-amber-900/50" : "border-white/10 bg-slate-800 hover:bg-slate-700"}`}
                @click=${() =>
                  this.eventBus.emit(new SendDomesticPolicyIntentEvent(policy))}
              >
                <div class="font-black uppercase">
                  ${policy === "very_low"
                    ? "Impôts minimes"
                    : policy === "low"
                      ? "Impôts faibles"
                      : policy === "normal"
                        ? "Impôts normaux"
                        : policy === "high"
                          ? "Impôts élevés"
                          : "Impôts extrêmes"}
                </div>
                <div class="mt-1 text-[11px] text-slate-400">
                  ${policy === "very_low"
                    ? "60% de revenus, +16 satisfaction"
                    : policy === "low"
                      ? "80% de revenus, +8 satisfaction"
                      : policy === "normal"
                        ? "100% de revenus, pression neutre"
                        : policy === "high"
                          ? "125% de revenus, -12 satisfaction"
                          : "155% de revenus, -24 satisfaction"}
                </div>
              </button>`,
          )}
        </div>
      </div>`;
  }

  private renderArmies(my: PlayerView) {
    const capacity = my.militaryCapacity();
    const targetPercent = my.mobilizationTarget();
    const targetTroops = Math.round(capacity * (targetPercent / 100));
    const cities = my
      .units(UnitType.City)
      .filter((unit) => !unit.isUnderConstruction())
      .reduce((sum, unit) => sum + unit.level(), 0);
    const bases = my
      .units(UnitType.DefensePost)
      .filter((unit) => !unit.isUnderConstruction())
      .reduce((sum, unit) => sum + unit.level(), 0);
    const upkeep = Math.ceil(my.troops() / 1_000);
    return html`<div class="eu4-title">État-major général</div>
      <h2 class="mb-4 text-2xl font-black">Capacité militaire nationale</h2>
      <div class="grid grid-cols-4 gap-3">
        ${this.metric(
          "Troupes actives",
          Math.floor(my.troops()).toLocaleString(),
        )}
        ${this.metric("Objectif", targetTroops.toLocaleString())}
        ${this.metric(
          "Capacité maximale",
          Math.floor(capacity).toLocaleString(),
        )}
        ${this.metric("Entretien", `${upkeep} or / seconde`)}
      </div>
      <div class="eu4-card mt-4">
        <div class="flex items-center justify-between">
          <div class="eu4-title">Mobilisation souhaitée</div>
          <b class="text-2xl text-amber-200">${targetPercent}%</b>
        </div>
        <input
          class="mt-4 w-full accent-amber-500"
          type="range"
          min="0"
          max="100"
          step="5"
          .value=${String(targetPercent)}
          @change=${(event: Event) =>
            this.eventBus.emit(
              new SendMobilizationIntentEvent(
                Number((event.target as HTMLInputElement).value),
              ),
            )}
        />
        <div class="mt-3 grid grid-cols-5 gap-2">
          ${[0, 25, 50, 75, 100].map(
            (percent) =>
              html`<button
                class=${`eu4-action text-center ${targetPercent === percent ? "border-amber-400 bg-amber-900/50" : ""}`}
                @click=${() =>
                  this.eventBus.emit(new SendMobilizationIntentEvent(percent))}
              >
                ${percent}%
              </button>`,
          )}
        </div>
        <p class="mt-3 text-xs text-slate-400">
          La consigne fixe une cible. Le recrutement ou la démobilisation se
          fait progressivement.
        </p>
      </div>
      <div class="mt-4 grid grid-cols-2 gap-3">
        <div class="eu4-card">
          <div class="eu4-title mb-2">Population civile</div>
          <div class="eu4-row"><span>Villes actives</span><b>${cities}</b></div>
          <div class="eu4-row">
            <span>Potentiel humain</span
            ><b
              >${Math.floor(my.civilianManpowerPotential()).toLocaleString()}</b
            >
          </div>
          <p class="mt-2 text-xs text-slate-400">
            Les villes déterminent l'essentiel du réservoir humain. Les terres
            vides n'ajoutent qu'un faible socle plafonné.
          </p>
        </div>
        <div class="eu4-card">
          <div class="eu4-title mb-2">Infrastructure militaire</div>
          <div class="eu4-row">
            <span>Bases militaires</span><b>${bases}</b>
          </div>
          <div class="eu4-row">
            <span>Part mobilisable</span
            ><b
              >${Math.round(
                (capacity / Math.max(1, my.civilianManpowerPotential())) * 100,
              )}%</b
            >
          </div>
          <p class="mt-2 text-xs text-slate-400">
            Les postes de défense servent de bases: ils augmentent la capacité
            et accélèrent la mobilisation sans créer de population.
          </p>
        </div>
      </div>`;
  }

  private renderDiplomacy(my: PlayerView, selected: PlayerView) {
    const now = this.game.ticks();
    const relation = selected
      .diplomaticRelations()
      .find((item) => item.otherID === my.id());
    const truces = selected.truces().filter((item) => item.expiresAt > now);
    const truceIDs = new Set(truces.map((item) => item.otherID));
    const naps = selected
      .nonAggressionPacts()
      .filter((item) => item.expiresAt > now && !truceIDs.has(item.otherID));
    const memories = selected
      .diplomaticMemories()
      .filter((item) => item.otherID === my.id())
      .slice(-8)
      .reverse();
    return html`<div class="eu4-title">Relations étrangères</div>
      <h2 class="mb-4 text-2xl font-black">${selected.displayName()}</h2>
      <div class="grid grid-cols-3 gap-3">
        ${this.metric(
          "Opinion",
          Math.round(relation?.opinion ?? 0),
        )}${this.metric(
          "Confiance",
          Math.round(relation?.trust ?? 50),
        )}${this.metric(
          "Menace perçue",
          Math.round(relation?.perceivedThreat ?? my.threat()),
        )}
      </div>
      <div class="grid grid-cols-2 gap-3 mt-3">
        <div class="eu4-card">
          <div class="eu4-title mb-2">Traités</div>
          ${naps.map(
            (item) =>
              html`<div class="eu4-row">
                <span>🤝 NAP avec ${this.playerName(item.otherID)}</span
                ><b>${this.deadline(item.expiresAt)}</b>
              </div>`,
          )}
          ${truces.map(
            (item) =>
              html`<div class="eu4-row">
                <span>🕊 Trêve avec ${this.playerName(item.otherID)}</span
                ><b>${this.deadline(item.expiresAt)}</b>
              </div>`,
          )}
          ${selected
            .tradeAgreements()
            .map(
              (item) =>
                html`<div class="eu4-row">
                  <span>📈 Commerce avec ${this.playerName(item.otherID)}</span
                  ><b>${this.deadline(item.expiresAt)}</b>
                </div>`,
            )}
          ${selected
            .guarantees()
            .map((id) => html`<div>🛡 Garantit ${this.playerName(id)}</div>`)}
          ${!naps.length &&
          !truces.length &&
          !selected.tradeAgreements().length &&
          !selected.guarantees().length
            ? html`<div class="text-sm text-slate-500">
                Aucun traité actif.
              </div>`
            : nothing}
        </div>
        <div class="eu4-card">
          <div class="eu4-title mb-2">Mémoire bilatérale</div>
          ${memories.length
            ? memories.map(
                (memory) =>
                  html`<div class="eu4-row text-xs">
                    <span>${memory.type.replace(/_/g, " ")}</span
                    ><span
                      >${formatWorldDate(
                        Math.max(
                          0,
                          this.game.ticksSinceStart() -
                            (now - memory.createdAt),
                        ),
                      )}</span
                    >
                  </div>`,
              )
            : html`<div class="text-sm text-slate-500">
                Aucun événement commun.
              </div>`}
        </div>
      </div>`;
  }

  private renderTrade(my: PlayerView, selected: PlayerView) {
    const contracts = my
      .tradeContracts()
      .filter(
        (contract) =>
          contract.sellerID === selected.id() ||
          contract.buyerID === selected.id(),
      );
    return html`<div class="eu4-title">Marché diplomatique</div>
      <h2 class="mb-4 text-2xl font-black">
        Commerce avec ${selected.displayName()}
      </h2>
      ${selected === my
        ? html`<div class="eu4-card text-slate-400">
            Choisis un autre pays dans la liste de gauche pour négocier.
          </div>`
        : html`<div class="eu4-card grid grid-cols-4 gap-3">
            <label class="text-xs"
              >Ressource<select
                class="mt-1 w-full rounded bg-slate-800 p-2"
                .value=${this.tradeResource}
                @change=${(event: Event) => {
                  this.tradeResource = (event.target as HTMLSelectElement)
                    .value as typeof this.tradeResource;
                }}
              >
                <option value="food">Nourriture</option>
                <option value="materials">Matériaux</option>
                <option value="fuel">Carburant</option>
              </select></label
            >${this.numberField(
              "Quantité",
              this.tradeAmount,
              1,
              1000,
              (value) => (this.tradeAmount = value),
            )}${this.numberField(
              "Prix en or",
              this.tradePrice,
              1,
              1_000_000,
              (value) => (this.tradePrice = value),
            )}${this.numberField(
              "Livraisons",
              this.tradeDeliveries,
              1,
              24,
              (value) => (this.tradeDeliveries = value),
            )}<button
              class="eu4-action bg-emerald-900/70"
              @click=${() => this.sendTrade(selected, "buy")}
            >
              ⬇ Importer</button
            ><button
              class="eu4-action bg-cyan-900/70"
              @click=${() => this.sendTrade(selected, "sell")}
            >
              ⬆ Exporter
            </button>
            <div class="col-span-2 self-center text-xs text-slate-400">
              Une livraison tous les 60 jours. Fonds et stocks sont revalidés.
            </div>
          </div>`}
      <div class="mt-4 eu4-card">
        <div class="eu4-title mb-2">Contrats et historique</div>
        ${contracts.length
          ? contracts.map(
              (contract) =>
                html`<div
                  class="mb-2 rounded border border-white/10 bg-black/20 p-3"
                >
                  <div class="eu4-row">
                    <b
                      >${contract.buyerID === my.id() ? "IMPORT" : "EXPORT"} ·
                      ${contract.resource.toUpperCase()}</b
                    ><span
                      class=${contract.status === "active"
                        ? "text-emerald-300"
                        : contract.status === "failed"
                          ? "text-red-300"
                          : "text-slate-400"}
                      >${contract.status.toUpperCase()}</span
                    >
                  </div>
                  <div class="text-xs text-slate-400">
                    ${contract.amountPerDelivery} unités contre
                    ${contract.pricePerDelivery} or ·
                    ${contract.deliveriesRemaining} restantes ·
                    ${contract.deliveredCount} livrées
                  </div>
                  ${contract.lastFailure
                    ? html`<div class="text-xs text-red-300">
                        Cause : ${contract.lastFailure.replace(/_/g, " ")}
                      </div>`
                    : nothing}${contract.status === "active"
                    ? html`<button
                        class="mt-2 rounded bg-red-900 px-2 py-1 text-xs"
                        @click=${() =>
                          this.eventBus.emit(
                            new SendTradeIntentEvent(
                              selected,
                              "cancel",
                              undefined,
                              undefined,
                              undefined,
                              undefined,
                              undefined,
                              contract.id,
                            ),
                          )}
                      >
                        Annuler
                      </button>`
                    : nothing}
                </div>`,
            )
          : html`<div class="text-sm text-slate-500">
              Aucun contrat avec ce pays.
            </div>`}
      </div>`;
  }

  private renderCrises(my: PlayerView, selected: PlayerView) {
    const crises = my
      .diplomaticCrises()
      .filter(
        (crisis) =>
          crisis.issuerID === selected.id() ||
          crisis.targetID === selected.id(),
      );
    return html`<div class="eu4-title">Escalade internationale</div>
      <h2 class="mb-4 text-2xl font-black">
        Crises avec ${selected.displayName()}
      </h2>
      ${crises.length
        ? crises.map(
            (crisis) =>
              html`<div class="eu4-card mb-3">
                <div class="eu4-row">
                  <b>${crisis.demand.replace(/_/g, " ").toUpperCase()}</b
                  ><span
                    class=${crisis.status === "pending"
                      ? "text-amber-300"
                      : "text-slate-300"}
                    >${crisis.status.toUpperCase()}</span
                  >
                </div>
                <div class="text-xs text-slate-400">
                  Émetteur : ${this.playerName(crisis.issuerID)} · Cible :
                  ${this.playerName(crisis.targetID)}
                </div>
                ${crisis.status === "pending"
                  ? html`<div class="mt-2 text-sm">
                      Échéance : <b>${this.deadline(crisis.deadlineAt)}</b>
                    </div>`
                  : nothing}
              </div>`,
          )
        : html`<div class="eu4-card text-slate-500">
            Aucune crise impliquant ce pays.
          </div>`}`;
  }

  private renderGovernment(my: PlayerView) {
    const profile = my.governmentProfile();
    const interests = my.nationalInterests();
    return html`<div class="eu4-title">Cour et cabinet</div>
      <h2 class="mb-4 text-2xl font-black">${profile.leaderName}</h2>
      <div class="grid grid-cols-2 gap-3">
        <div class="eu4-card">
          <div class="eu4-title mb-2">Gouvernement</div>
          <div class="eu4-row">
            <span>Orientation</span><b>${profile.style.toUpperCase()}</b>
          </div>
          <div class="eu4-row">
            <span>Génération</span><b>${profile.generation}</b>
          </div>
          <div class="eu4-row">
            <span>Fin du mandat</span
            ><b>${this.deadline(profile.termEndsAt)}</b>
          </div>
          <div class="eu4-row">
            <span>Inclination commerciale</span
            ><b
              >${profile.tradeBias >= 0 ? "+" : ""}${Math.round(
                profile.tradeBias * 100,
              )}%</b
            >
          </div>
          <div class="eu4-row">
            <span>Tolérance au risque</span
            ><b>${Math.round(profile.riskTolerance * 100)}%</b>
          </div>
        </div>
        <div class="eu4-card">
          <div class="eu4-title mb-2">Situation intérieure</div>
          <div class="eu4-row">
            <span>Stabilité</span><b>${Math.round(my.stability())}/100</b>
          </div>
          <div class="eu4-row">
            <span>Satisfaction</span
            ><b>${Math.round(my.publicSatisfaction())}/100</b>
          </div>
          <div class="eu4-row">
            <span>Fiscalité</span><b>${my.taxPolicy().toUpperCase()}</b>
          </div>
          <div class="eu4-row">
            <span>Priorité sécurité</span><b>${interests.security}/100</b>
          </div>
          <div class="eu4-row">
            <span>Priorité expansion</span><b>${interests.expansion}/100</b>
          </div>
        </div>
      </div>
      <div class="eu4-card mt-3 text-sm text-slate-400">
        Les successions changent le profil de décision. Les obligations restent
        attachées au pays.
      </div>`;
  }

  private renderContextActions(my: PlayerView, selected: PlayerView) {
    if (this.activeTab === "economy")
      return html`<div class="eu4-title mb-3">Effets actuels</div>
        <div class="eu4-card text-xs">
          <div class="eu4-row">
            <span>Revenu fiscal</span
            ><b
              >${my.taxPolicy() === "very_low"
                ? "60%"
                : my.taxPolicy() === "low"
                  ? "80%"
                  : my.taxPolicy() === "high"
                    ? "125%"
                    : my.taxPolicy() === "very_high"
                      ? "155%"
                      : "100%"}</b
            >
          </div>
          <div class="eu4-row">
            <span>Stabilité</span><b>${Math.round(my.stability())}</b>
          </div>
          <div class="eu4-row">
            <span>Satisfaction</span
            ><b>${Math.round(my.publicSatisfaction())}</b>
          </div>
        </div>`;
    if (this.activeTab === "armies")
      return html`<div class="eu4-title mb-3">Doctrine de mobilisation</div>
        <div class="eu4-card space-y-2 text-xs text-slate-300">
          <p>Les villes fournissent le potentiel humain national.</p>
          <p>Les postes de défense servent de bases militaires.</p>
          <p>Le curseur fixe une cible atteinte progressivement.</p>
          <p>L'entretien dépend du nombre de soldats actifs.</p>
        </div>`;
    if (selected === my)
      return html`<div class="eu4-title mb-3">Conseil</div>
        <div class="text-sm text-slate-400">
          Choisis un autre pays pour afficher les actions bilatérales.
        </div>`;
    return html`<div class="eu4-title mb-1">Actions</div>
      <div class="mb-3 text-lg font-black">${selected.displayName()}</div>
      <div class="grid gap-2">
        <button
          class="eu4-action"
          @click=${() => this.emitDiplomacy(selected, "offer_nap")}
        >
          🤝 Proposer un NAP
        </button>
        <button
          class="eu4-action"
          @click=${() =>
            this.emitDiplomacy(
              selected,
              my.guarantees().includes(selected.id())
                ? "withdraw_guarantee"
                : "guarantee",
            )}
        >
          🛡
          ${my.guarantees().includes(selected.id())
            ? "Retirer la garantie"
            : "Garantir l'indépendance"}
        </button>
        <button
          class="eu4-action"
          @click=${() => this.emitDiplomacy(selected, "economic_aid")}
        >
          💰 Envoyer 500 or d'aide
        </button>
        <button
          class="eu4-action"
          @click=${() => this.emitDiplomacy(selected, "joint_project")}
        >
          🏗 Projet commun
        </button>
        <button
          class="eu4-action"
          @click=${() => this.emitDiplomacy(selected, "trade_agreement")}
        >
          📈 Accord préférentiel
        </button>
        <button
          class="eu4-action"
          @click=${() =>
            this.eventBus.emit(
              new SendEmbargoIntentEvent(
                selected,
                my.hasEmbargo(selected) ? "stop" : "start",
              ),
            )}
        >
          🚫
          ${my.hasEmbargo(selected) ? "Lever l'embargo" : "Imposer un embargo"}
        </button>
        <button
          class="eu4-action border-orange-600/50 bg-orange-950/60"
          @click=${() => this.emitDiplomacy(selected, "ultimatum")}
        >
          ⚠ Ultimatum
        </button>
        <button
          class="eu4-action"
          @click=${() => this.emitDiplomacy(selected, "offer_concession")}
        >
          📜 Faire une concession
        </button>
        <button
          class="eu4-action"
          @click=${() => this.emitDiplomacy(selected, "mediate_crisis")}
        >
          ⚖ Proposer une médiation
        </button>
        <button
          class="eu4-action"
          @click=${() => this.emitDiplomacy(selected, "offer_white_peace")}
        >
          🕊 Paix blanche
        </button>
        <button
          class="eu4-action border-red-700/50 bg-red-950/60"
          @click=${() => this.emitDiplomacy(selected, "demand_reparations")}
        >
          💰 Exiger des réparations
        </button>
      </div>
      <div
        class="mt-3 rounded border border-white/10 bg-black/20 p-2 text-[10px] text-slate-500"
      >
        Les propositions restent dans le menu. En pause, elles sont enregistrées
        et leur réponse arrive à la reprise.
      </div>`;
  }

  private metric(label: string, value: number | string) {
    const tone =
      typeof value !== "number"
        ? "text-amber-200"
        : value < 0
          ? "text-red-300"
          : value >= 50
            ? "text-emerald-300"
            : "text-amber-200";
    return html`<div class="eu4-card text-center">
      <div class="text-[10px] uppercase tracking-wide text-slate-400">
        ${label}
      </div>
      <div class=${`mt-1 text-2xl font-black ${tone}`}>${value}</div>
    </div>`;
  }

  private numberField(
    label: string,
    value: number,
    min: number,
    max: number,
    set: (value: number) => void,
  ) {
    return html`<label class="text-xs"
      >${label}<input
        type="number"
        min=${min}
        max=${max}
        class="mt-1 w-full rounded bg-slate-800 p-2"
        .value=${String(value)}
        @change=${(event: Event) =>
          set(
            Math.max(
              min,
              Math.min(
                max,
                Math.round(Number((event.target as HTMLInputElement).value)),
              ),
            ),
          )}
    /></label>`;
  }

  private playerName(id: string): string {
    try {
      return this.game.player(id).displayName();
    } catch {
      return id;
    }
  }

  private emitDiplomacy(
    target: PlayerView,
    action: ConstructorParameters<typeof SendDiplomacyPlusIntentEvent>[1],
  ) {
    this.eventBus.emit(new SendDiplomacyPlusIntentEvent(target, action));
  }

  private sendTrade(target: PlayerView, direction: "buy" | "sell") {
    this.eventBus.emit(
      new SendTradeIntentEvent(
        target,
        "offer",
        direction,
        this.tradeResource,
        this.tradeAmount,
        this.tradePrice,
        this.tradeDeliveries,
      ),
    );
  }
}
