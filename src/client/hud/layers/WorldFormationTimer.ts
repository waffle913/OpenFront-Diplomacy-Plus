import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { WORLD_FORMATION_END_TICK } from "../../../core/game/Game";
import { GameView } from "../../view";
@customElement("world-formation-timer")
export class WorldFormationTimer extends LitElement implements Controller {
  public game: GameView;
  createRenderRoot() {
    this.style.position="fixed"; this.style.top="14px"; this.style.left="50%";
    this.style.transform="translateX(-50%)"; this.style.zIndex="1200";
    this.style.pointerEvents="none"; return this;
  }
  init() {}
  tick() { this.requestUpdate(); }
  render() {
    if (!this.game || this.game.inSpawnPhase() || this.game.ticksSinceStart() >= WORLD_FORMATION_END_TICK) return html``;
    const seconds=Math.ceil((WORLD_FORMATION_END_TICK-this.game.ticksSinceStart())/10);
    return html`<div class="rounded-lg bg-slate-950/90 border border-sky-400/60 shadow-xl px-4 py-2 text-center text-white">
      <div class="text-xs font-black tracking-widest text-sky-300">🌐 WORLD PEACE</div>
      <div class="text-sm font-bold">${seconds}s</div>
      <div class="text-[10px] text-slate-300">Tribes are forming historical regions · nations arrive when peace ends</div>
    </div>`;
  }
}