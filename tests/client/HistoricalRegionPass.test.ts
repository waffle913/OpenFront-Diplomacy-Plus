import { describe, expect, it } from "vitest";
import { historicalRegionBoundaryStyle } from "../../src/client/render/gl/passes/HistoricalRegionPass";

describe("historical region boundary style", () => {
  it("becomes thicker and more visible as the camera zooms in", () => {
    const distant = historicalRegionBoundaryStyle(0.9);
    const close = historicalRegionBoundaryStyle(4);
    expect(close.pointSize).toBeGreaterThan(distant.pointSize);
    expect(close.color[3]).toBeGreaterThan(distant.color[3]);
    expect(close.color[0]).toBeGreaterThan(distant.color[0]);
  });

  it("clamps extreme zoom levels", () => {
    expect(historicalRegionBoundaryStyle(100)).toEqual(
      historicalRegionBoundaryStyle(4),
    );
  });
});
