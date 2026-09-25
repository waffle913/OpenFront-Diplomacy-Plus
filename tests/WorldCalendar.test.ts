import { describe, expect, it } from "vitest";
import {
  formatWorldDate,
  formatWorldDeadline,
  worldDateAtTick,
} from "../src/core/game/WorldCalendar";

describe("fictional world calendar", () => {
  it.each([
    [0, { year: 1, month: 1, day: 1 }],
    [9, { year: 1, month: 1, day: 1 }],
    [10, { year: 1, month: 1, day: 2 }],
    [309, { year: 1, month: 1, day: 31 }],
    [310, { year: 1, month: 2, day: 1 }],
    [589, { year: 1, month: 2, day: 28 }],
    [590, { year: 1, month: 3, day: 1 }],
    [3649, { year: 1, month: 12, day: 31 }],
    [3650, { year: 2, month: 1, day: 1 }],
    [14600, { year: 5, month: 1, day: 1 }],
  ])("maps tick %s to its calendar date", (ticks, expected) => {
    expect(worldDateAtTick(ticks)).toEqual(expected);
  });
  it("formats a date independently of the computer clock and timezone", () => {
    expect(formatWorldDate(590)).toBe("1 mars · an 1");
    expect(formatWorldDate(3650)).toBe("1 janvier · an 2");
  });
  it.each([-10, NaN, Infinity])(
    "uses the start date for invalid or negative time %s",
    (ticks) => {
      expect(formatWorldDate(ticks)).toBe("1 janvier · an 1");
    },
  );

  it("maps absolute deadlines onto elapsed world time", () => {
    expect(formatWorldDeadline(1500, 1000, 300)).toBe("22 mars · an 1");
    expect(formatWorldDeadline(900, 1000, 300)).toBe("31 janvier · an 1");
  });
});
