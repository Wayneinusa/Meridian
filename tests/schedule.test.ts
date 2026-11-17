import { describe, expect, it } from "vitest";
import { describeSchedule, lastDue, nextRun } from "../src/automations/schedule";

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("automation schedules", () => {
  it("daily, with and without weekdays", () => {
    const mon9 = local(2026, 11, 16, 9, 0); // a Monday
    expect(nextRun({ type: "daily", time: "08:30" }, mon9)).toBe(local(2026, 11, 17, 8, 30));
    expect(nextRun({ type: "daily", time: "10:00" }, mon9)).toBe(local(2026, 11, 16, 10, 0));
    // weekdays only: Friday evening -> Monday
    expect(nextRun({ type: "daily", time: "07:00", days: [1, 2, 3, 4, 5] }, local(2026, 11, 20, 18))).toBe(local(2026, 11, 23, 7));
  });

  it("weekly, monthly (short months), once and intervals", () => {
    expect(nextRun({ type: "weekly", time: "17:00", days: [5] }, local(2026, 11, 16))).toBe(local(2026, 11, 20, 17));
    expect(nextRun({ type: "monthly", time: "09:00", day: 31 }, local(2027, 2, 1))).toBe(local(2027, 2, 28, 9));
    expect(nextRun({ type: "once", at: 500 }, 100)).toBe(500);
    expect(nextRun({ type: "once", at: 500 }, 600)).toBeNull();
    const created = local(2026, 11, 16, 9);
    expect(nextRun({ type: "interval", minutes: 90 }, created + 10 * 60_000, created)).toBe(created + 90 * 60_000);
    expect(nextRun({ type: "interval", minutes: 90 }, created + 90 * 60_000, created)).toBe(created + 180 * 60_000);
  });

  it("finds the missed run for catch-up", () => {
    const created = local(2026, 11, 1);
    expect(lastDue({ type: "daily", time: "08:00" }, local(2026, 11, 16, 12), created)).toBe(local(2026, 11, 16, 8));
    expect(lastDue({ type: "daily", time: "08:00" }, local(2026, 11, 16, 7), created)).toBe(local(2026, 11, 15, 8));
    expect(lastDue({ type: "interval", minutes: 60 }, created + 150 * 60_000, created)).toBe(created + 120 * 60_000);
    expect(lastDue({ type: "once", at: created + 5 }, created, created)).toBeNull();
  });

  it("describes schedules", () => {
    expect(describeSchedule({ type: "interval", minutes: 120 })).toBe("Every 2 hour(s)");
    expect(describeSchedule({ type: "daily", time: "08:00", days: [1, 2, 3, 4, 5] })).toBe("Daily at 08:00 (Mon, Tue, Wed, Thu, Fri)");
  });
});
