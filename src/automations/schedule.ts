// When an automation runs. Times are in the device's local time zone.
import type { Schedule } from "../types";

function at(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  const d = new Date(day);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/** The first run strictly after `after` (ms), or null when there is none. */
export function nextRun(s: Schedule, after: number, created = after): number | null {
  switch (s.type) {
    case "once":
      return s.at > after ? s.at : null;
    case "interval": {
      const step = Math.max(1, s.minutes) * 60_000;
      const n = Math.floor((after - created) / step) + 1;
      return created + Math.max(1, n) * step;
    }
    case "daily":
    case "weekly": {
      const days = s.type === "weekly" ? s.days : (s.days?.length ? s.days : [0, 1, 2, 3, 4, 5, 6]);
      if (!days.length) return null;
      const start = new Date(after);
      for (let i = 0; i < 8; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        if (!days.includes(d.getDay())) continue;
        const t = at(d, s.time).getTime();
        if (t > after) return t;
      }
      return null;
    }
    case "monthly": {
      const start = new Date(after);
      for (let i = 0; i < 14; i++) {
        const y = start.getFullYear();
        const mo = start.getMonth() + i;
        const last = new Date(y, mo + 1, 0).getDate();
        const d = new Date(y, mo, Math.min(s.day, last));
        const t = at(d, s.time).getTime();
        if (t > after) return t;
      }
      return null;
    }
  }
}

/** The most recent scheduled time at or before `now` (for catching up missed runs). */
export function lastDue(s: Schedule, now: number, created: number): number | null {
  if (s.type === "once") return s.at <= now ? s.at : null;
  // walk forward from a little before `now`; schedules repeat at most daily-ish except intervals
  if (s.type === "interval") {
    const step = Math.max(1, s.minutes) * 60_000;
    if (now < created + step) return null;
    return created + Math.floor((now - created) / step) * step;
  }
  let probe = now - 32 * 86_400_000;
  let last: number | null = null;
  for (let i = 0; i < 200; i++) {
    const n = nextRun(s, probe, created);
    if (n == null || n > now) break;
    last = n;
    probe = n;
  }
  return last;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case "once":
      return `Once, ${new Date(s.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    case "interval":
      return s.minutes % 1440 === 0 ? `Every ${s.minutes / 1440} day(s)` : s.minutes % 60 === 0 ? `Every ${s.minutes / 60} hour(s)` : `Every ${s.minutes} minutes`;
    case "daily":
      return `Daily at ${s.time}${s.days?.length && s.days.length < 7 ? ` (${s.days.map((d) => DAY[d]).join(", ")})` : ""}`;
    case "weekly":
      return `Weekly on ${s.days.map((d) => DAY[d]).join(", ")} at ${s.time}`;
    case "monthly":
      return `Monthly on day ${s.day} at ${s.time}`;
  }
}
