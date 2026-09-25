/** Fictional world calendar. All dates derive from simulation time, never wall time.
 * Year 1 starts on January 1. Years have 365 days, without leap years.
 * Adjust ticksPerDay here to rebalance the calendar without changing game rules.
 */
export const WORLD_CALENDAR = Object.freeze({
  startYear: 1,
  ticksPerDay: 10,
  daysPerYear: 365,
});

const MONTHS = [
  { name: "janvier", days: 31 },
  { name: "février", days: 28 },
  { name: "mars", days: 31 },
  { name: "avril", days: 30 },
  { name: "mai", days: 31 },
  { name: "juin", days: 30 },
  { name: "juillet", days: 31 },
  { name: "août", days: 31 },
  { name: "septembre", days: 30 },
  { name: "octobre", days: 31 },
  { name: "novembre", days: 30 },
  { name: "décembre", days: 31 },
] as const;

export interface WorldDate {
  year: number;
  month: number;
  day: number;
}

export function worldDateAtTick(elapsedTicks: number): WorldDate {
  const ticks = Number.isFinite(elapsedTicks) ? Math.max(0, elapsedTicks) : 0;
  const elapsedDays = Math.floor(ticks / WORLD_CALENDAR.ticksPerDay);
  const year =
    WORLD_CALENDAR.startYear +
    Math.floor(elapsedDays / WORLD_CALENDAR.daysPerYear);
  let dayOfYear = elapsedDays % WORLD_CALENDAR.daysPerYear;
  let month = 0;
  while (dayOfYear >= MONTHS[month].days) {
    dayOfYear -= MONTHS[month].days;
    month++;
  }
  return { year, month: month + 1, day: dayOfYear + 1 };
}

export function formatWorldDate(elapsedTicks: number): string {
  const date = worldDateAtTick(elapsedTicks);
  return `${date.day} ${MONTHS[date.month - 1].name} · an ${date.year}`;
}

/**
 * Convert an absolute game-tick deadline to the fictional calendar. Game tick
 * zero may include a spawn phase, so callers also provide the elapsed world
 * ticks corresponding to the current absolute tick.
 */
export function formatWorldDeadline(
  deadlineTick: number,
  currentTick: number,
  elapsedWorldTicks: number,
): string {
  const remaining = Math.max(0, deadlineTick - currentTick);
  return formatWorldDate(elapsedWorldTicks + remaining);
}
