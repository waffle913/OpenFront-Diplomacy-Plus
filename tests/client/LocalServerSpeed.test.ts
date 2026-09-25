import { describe, expect, it } from "vitest";
import { liveTurnTiming } from "../../src/client/LocalServer";
import { ReplaySpeedMultiplier } from "../../src/client/utilities/ReplaySpeedMultiplier";

describe("local game speed", () => {
  it("uses distinct live cadences and progressively larger bounded pipelines", () => {
    const slow = liveTurnTiming(ReplaySpeedMultiplier.slow);
    const normal = liveTurnTiming(ReplaySpeedMultiplier.normal);
    const fast = liveTurnTiming(ReplaySpeedMultiplier.fast);
    const fastest = liveTurnTiming(ReplaySpeedMultiplier.fastest);

    expect([
      slow.intervalMultiplier,
      normal.intervalMultiplier,
      fast.intervalMultiplier,
      fastest.intervalMultiplier,
    ]).toEqual([2, 1, 0.5, 0.25]);
    expect([
      slow.maxBacklog,
      normal.maxBacklog,
      fast.maxBacklog,
      fastest.maxBacklog,
    ]).toEqual([1, 2, 4, 8]);
  });
});
