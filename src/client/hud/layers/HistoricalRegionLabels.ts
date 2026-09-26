import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { TransformHandler } from "../../TransformHandler";
import { GameView } from "../../view";

export interface HistoricalRegionLabelCandidate {
  id: number;
  name: string;
  tileCount: number;
  x: number;
  y: number;
}

export interface HistoricalRegionLabel {
  id: number;
  name: string;
  x: number;
  y: number;
}

interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const MIN_REGION_LABEL_ZOOM = 1.15;

export function layoutHistoricalRegionLabels(
  candidates: readonly HistoricalRegionLabelCandidate[],
  zoom: number,
  viewport: { left: number; top: number; right: number; bottom: number },
): HistoricalRegionLabel[] {
  if (zoom < MIN_REGION_LABEL_ZOOM) return [];
  const maximumLabels = zoom >= 3.2 ? 72 : zoom >= 2 ? 42 : 24;
  const padding = zoom >= 2.4 ? 5 : 9;
  const occupied: LabelBox[] = [];
  const labels: HistoricalRegionLabel[] = [];

  for (const candidate of [...candidates].sort(
    (a, b) => b.tileCount - a.tileCount || a.id - b.id,
  )) {
    if (
      candidate.x < viewport.left + 20 ||
      candidate.x > viewport.right - 20 ||
      candidate.y < viewport.top + 12 ||
      candidate.y > viewport.bottom - 12
    )
      continue;
    const width = Math.min(132, Math.max(34, candidate.name.length * 6.2));
    const box: LabelBox = {
      left: candidate.x - width / 2 - padding,
      right: candidate.x + width / 2 + padding,
      top: candidate.y - 8 - padding,
      bottom: candidate.y + 8 + padding,
    };
    if (
      occupied.some(
        (other) =>
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top,
      )
    )
      continue;
    occupied.push(box);
    labels.push({
      id: candidate.id,
      name: candidate.name,
      x: candidate.x,
      y: candidate.y,
    });
    if (labels.length >= maximumLabels) break;
  }
  return labels;
}

@customElement("historical-region-labels")
export class HistoricalRegionLabels extends LitElement implements Controller {
  @property({ attribute: false }) public game!: GameView;
  @property({ attribute: false }) public transform!: TransformHandler;
  @state() private labels: HistoricalRegionLabel[] = [];
  private layoutKey = "";

  createRenderRoot() {
    return this;
  }

  getTickIntervalMs() {
    return 100;
  }

  tick() {
    if (!this.game || !this.transform) return;
    const zoom = this.transform.scale;
    if (zoom < MIN_REGION_LABEL_ZOOM) {
      if (this.labels.length > 0) {
        this.labels = [];
        this.layoutKey = "";
      }
      return;
    }
    const rect = this.transform.boundingRect();
    const candidates = this.game.historicalRegions().map((region) => {
      const position = this.transform.worldToScreenCoordinates(
        this.game.cell(region.representativeTile),
      );
      return {
        id: region.id,
        name: region.name,
        tileCount: region.tileCount,
        x: position.x,
        y: position.y,
      };
    });
    const labels = layoutHistoricalRegionLabels(candidates, zoom, {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    });
    const key = labels
      .map(
        (label) => `${label.id}:${Math.round(label.x)}:${Math.round(label.y)}`,
      )
      .join("|");
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.labels = labels;
    }
  }

  render() {
    if (this.labels.length === 0) return nothing;
    return html`<div
      class="pointer-events-none fixed inset-0 z-[4] overflow-hidden"
      aria-hidden="true"
    >
      ${this.labels.map(
        (label) =>
          html`<span
            class="absolute max-w-[132px] -translate-x-1/2 -translate-y-1/2 truncate whitespace-nowrap rounded-sm bg-slate-950/30 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-white/75 shadow-sm backdrop-blur-[1px]"
            style=${`left:${label.x}px;top:${label.y}px;text-shadow:0 1px 2px #000,0 0 4px #000`}
            >${label.name}</span
          >`,
      )}
    </div>`;
  }
}
