import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { GameView } from "../../view";
interface N {
  id: number;
  title: string;
  body: string;
  until: number;
}
@customElement("diplomacy-notification")
export class DiplomacyNotification extends LitElement implements Controller {
  public game: GameView;
  @state() private notices: N[] = [];
  private known = new Map<string, string>();
  private ready = false;
  private seq = 1;
  init() {
    this.base();
  }
  getTickIntervalMs() {
    return 150;
  }
  tick() {
    if (!this.game || this.game.inSpawnPhase()) return;
    const me = this.game.myPlayer();
    if (!me?.isPlayer()) return;
    const now = this.game.ticks(),
      cur = new Map<string, string>();
    for (const cb of me.casusBelli()) {
      if (cb.expiresAt <= now) continue;
      cur.set(cb.targetID, cb.type);
      if (
        this.ready &&
        !this.known.has(cb.targetID) &&
        cb.type !== "containment"
      ) {
        let n = cb.targetID;
        try {
          n = this.game.player(cb.targetID).displayName();
        } catch {
          /* Keep the stable country ID when the view has already disappeared. */
        }
        this.add(
          "CASUS BELLI ACQUIRED",
          `${cb.type.replace(/_/g, " ").toUpperCase()} → ${n} · ${cb.expiresAt - now}t`,
        );
      }
    }
    this.known = cur;
    this.ready = true;
    const ms = Date.now();
    this.notices = this.notices.filter((n) => n.until > ms);
  }
  private base() {
    if (!this.game) return;
    const me = this.game.myPlayer();
    if (!me?.isPlayer()) return;
    const now = this.game.ticks();
    for (const cb of me.casusBelli())
      if (cb.expiresAt > now) this.known.set(cb.targetID, cb.type);
    this.ready = true;
  }
  private add(title: string, body: string) {
    this.notices = [
      ...this.notices,
      { id: this.seq++, title, body, until: Date.now() + 8500 },
    ].slice(-4);
  }
  render() {
    return html`<div
      class="fixed right-4 top-28 z-[1100] flex w-[390px] max-w-[calc(100vw-32px)] flex-col gap-2 pointer-events-none"
    >
      ${this.notices.map(
        (n) =>
          html`<div
            class="pointer-events-auto rounded-lg border border-amber-400 bg-zinc-950/95 px-3 py-2 text-zinc-100 shadow-2xl"
          >
            <div class="text-xs font-black text-amber-300">⚖ ${n.title}</div>
            <div class="mt-1 text-xs">${n.body}</div>
          </div>`,
      )}
    </div>`;
  }
  createRenderRoot() {
    return this;
  }
}
