import { TileRef } from "./GameMap";

export function findInteriorRegionTile(
  regionID: number,
  centroidX: number,
  centroidY: number,
  width: number,
  height: number,
  regionIDs: Uint32Array,
  fallback: TileRef,
): TileRef {
  const centerX = Math.max(0, Math.min(width - 1, Math.round(centroidX)));
  const centerY = Math.max(0, Math.min(height - 1, Math.round(centroidY)));
  const ref = (x: number, y: number) => y * width + x;
  if (regionIDs[ref(centerX, centerY)] === regionID)
    return ref(centerX, centerY);

  const maximumRadius = Math.max(width, height);
  for (let radius = 1; radius <= maximumRadius; radius++) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    const consider = (x: number, y: number) => {
      if (x < 0 || x >= width || y < 0 || y >= height) return;
      const tile = ref(x, y);
      if (regionIDs[tile] !== regionID) return;
      const distance =
        (x - centroidX) * (x - centroidX) + (y - centroidY) * (y - centroidY);
      if (distance < bestDistance) {
        best = tile;
        bestDistance = distance;
      }
    };
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      consider(x, centerY - radius);
      consider(x, centerY + radius);
    }
    for (let y = centerY - radius + 1; y < centerY + radius; y++) {
      consider(centerX - radius, y);
      consider(centerX + radius, y);
    }
    if (best !== -1) return best;
  }
  return fallback;
}
