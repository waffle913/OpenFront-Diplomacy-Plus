import { describe, expect, it } from "vitest";
import { findInteriorRegionTile } from "../src/core/game/HistoricalRegionGeometry";

describe("historical region representative tile", () => {
  it("uses the centroid when it belongs to the region", () => {
    const ids = new Uint32Array(25);
    ids[2 + 2 * 5] = 7;
    expect(findInteriorRegionTile(7, 2, 2, 5, 5, ids, 0)).toBe(12);
  });

  it("finds the nearest interior tile when a concave region excludes its centroid", () => {
    const ids = new Uint32Array(49);
    for (let x = 1; x <= 5; x++) ids[x + 1 * 7] = 3;
    for (let y = 1; y <= 5; y++) ids[1 + y * 7] = 3;
    const tile = findInteriorRegionTile(3, 2.7, 2.7, 7, 7, ids, 8);
    expect(ids[tile]).toBe(3);
    expect(tile).not.toBe(8);
  });
});
