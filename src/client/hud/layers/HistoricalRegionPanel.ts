import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { Controller } from "../../Controller";
import { GameView } from "../../view";

export class ShowHistoricalRegionEvent {
  constructor(public readonly regionID: number) {}
}

@customElement("historical-region-panel")
export class HistoricalRegionPanel extends LitElement implements Controller {
  @property({ attribute: false }) game!: GameView;
  @property({ attribute: false }) eventBus!: EventBus;

  private isVisible = false;
  private selectedRegionID: number | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    this.eventBus.on(ShowHistoricalRegionEvent, (e) => this.show(e.regionID));
  }

  getTickIntervalMs() {
    return 500;
  }

  tick() {
    if (this.isVisible) this.requestUpdate();
  }

  show(regionID: number) {
    this.selectedRegionID = regionID;
    this.isVisible = true;
    this.requestUpdate();
  }

  hide() {
    this.isVisible = false;
    this.selectedRegionID = null;
    this.requestUpdate();
  }

  private playerName(id: string): string {
    try {
      return this.game.player(id).displayName();
    } catch {
      return id;
    }
  }

  private resourceRow(icon: string, label: string, value: number) {
    return html`
      <div class="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
        <div class="text-[10px] uppercase tracking-wider text-slate-400">${label}</div>
        <div class="mt-0.5 text-lg font-black tabular-nums">${icon} ${value.toFixed(0)}<span class="ml-1 text-[10px] font-normal text-slate-400">/min</span></div>
      </div>
    `;
  }

  render() {
    if (!this.isVisible || this.selectedRegionID === null) return html``;
    const region = this.game.historicalRegions().find((r) => r.id === this.selectedRegionID);
    if (!region) return html``;

    const controllers = (region.controllers ?? []).filter((c) => c.share > 0.0001);
    const founderName = this.playerName(region.founderID);
    const contested = controllers.length > 1;

    return html`
      <div class="fixed inset-0 z-[10025] pointer-events-none">
        <aside
          class="pointer-events-auto absolute right-4 top-1/2 -translate-y-1/2
                 w-[410px] max-w-[calc(100vw-2rem)] max-h-[88vh] overflow-y-auto
                 rounded-xl border border-emerald-400/55 bg-slate-950/95 text-slate-100
                 shadow-2xl backdrop-blur-md p-4"
          @contextmenu=${(e: MouseEvent) => e.preventDefault()}
          @wheel=${(e: MouseEvent) => e.stopPropagation()}
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-[10px] tracking-[.18em] text-emerald-300 font-bold">REGION DOSSIER</div>
              <div class="text-xl font-black leading-tight">${region.name}</div>
              <div class="text-xs text-slate-400">Historical Region #${region.id} · ${region.tileCount} tiles</div>
            </div>
            <button class="rounded-md px-2 py-1 bg-white/10 hover:bg-white/20 font-bold"
              @click=${() => this.hide()}>✕</button>
          </div>

          <div class="mt-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs">
            <div class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <span class="text-slate-400">Founding core</span><b>${founderName}</b>
              <span class="text-slate-400">Political status</span>
              <b class=${contested ? "text-amber-300" : "text-emerald-300"}>${contested ? "CONTESTED" : "CONSOLIDATED"}</b>
            </div>
          </div>

          <div class="mt-4">
            <div class="mb-2 text-[11px] font-black tracking-wider text-emerald-200">RESOURCE POTENTIAL · 100% CONTROL</div>
            <div class="grid grid-cols-3 gap-2">
              ${this.resourceRow("🌾", "Food", region.resources.food)}
              ${this.resourceRow("🧱", "Materials", region.resources.materials)}
              ${this.resourceRow("⛽", "Fuel", region.resources.fuel)}
            </div>
            <div class="mt-2 text-[10px] text-slate-500">Actual national output is proportional to territorial control of this historical region.</div>
          </div>

          <div class="mt-4 border-t border-white/10 pt-3">
            <div class="mb-2 text-[11px] font-black tracking-wider text-sky-200">CURRENT CONTROL</div>
            ${controllers.length
              ? controllers.map((c) => {
                  const pct = Math.round(c.share * 1000) / 10;
                  return html`
                    <div class="mb-2 rounded-lg border border-white/10 bg-white/4 px-3 py-2">
                      <div class="flex items-center justify-between gap-3">
                        <b class="truncate">${this.playerName(c.playerID)}</b>
                        <span class="font-black tabular-nums">${pct}%</span>
                      </div>
                      <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                        <div class="h-full bg-sky-400/80" style=${`width:${Math.max(1, Math.min(100, pct))}%`}></div>
                      </div>
                      <div class="mt-1 text-[10px] text-slate-400">
                        ${c.tiles} tiles · 🌾 ${(region.resources.food * c.share).toFixed(1)}/m ·
                        🧱 ${(region.resources.materials * c.share).toFixed(1)}/m ·
                        ⛽ ${(region.resources.fuel * c.share).toFixed(1)}/m
                      </div>
                    </div>
                  `;
                })
              : html`<div class="text-slate-500">No current political controller.</div>`}
          </div>
        </aside>
      </div>
    `;
  }
}
