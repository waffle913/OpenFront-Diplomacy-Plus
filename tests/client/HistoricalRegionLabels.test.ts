import { describe, expect, it } from "vitest";
import { layoutHistoricalRegionLabels } from "../../src/client/hud/layers/HistoricalRegionLabels";

const viewport = { left: 0, top: 0, right: 800, bottom: 600 };

describe("historical region label layout", () => {
  it("hides labels until the player zooms in", () => {
    expect(
      layoutHistoricalRegionLabels(
        [{ id: 1, name: "Normandie", tileCount: 100, x: 200, y: 200 }],
        1,
        viewport,
      ),
    ).toEqual([]);
  });

  it("keeps the larger region when labels overlap", () => {
    const labels = layoutHistoricalRegionLabels(
      [
        { id: 1, name: "Grande région", tileCount: 500, x: 200, y: 200 },
        { id: 2, name: "Petite région", tileCount: 50, x: 205, y: 202 },
      ],
      1.8,
      viewport,
    );
    expect(labels.map((label) => label.id)).toEqual([1]);
  });

  it("only returns labels whose anchors are visible", () => {
    const labels = layoutHistoricalRegionLabels(
      [
        { id: 1, name: "Visible", tileCount: 100, x: 300, y: 300 },
        { id: 2, name: "Hors écran", tileCount: 200, x: 900, y: 300 },
      ],
      2.5,
      viewport,
    );
    expect(labels.map((label) => label.name)).toEqual(["Visible"]);
  });
});
