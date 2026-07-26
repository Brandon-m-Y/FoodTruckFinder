// All display is in America/New_York — the county's wall clock — regardless of
// where the viewer's browser is. Schedules are authored in local time and the
// database materializes them against that zone; showing anything else would
// make a 5pm Thursday slot read as 5pm somewhere it isn't.
const TZ = "America/New_York";

const dayTime = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit",
});
const timeOnly = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hour: "numeric", minute: "2-digit",
});
const dayOnly = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, weekday: "long", month: "short", day: "numeric",
});

const dayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

/** "Thu 5:00 PM – 9:00 PM", collapsing the day when both ends share one. */
export function fmtRange(startsAt, endsAt) {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const sameDay = dayKey.format(s) === dayKey.format(e);
  return sameDay
    ? `${dayTime.format(s)} – ${timeOnly.format(e)}`
    : `${dayTime.format(s)} – ${dayTime.format(e)}`;
}

/** Label for the scrubber: "now", "today 7:00 PM", "Thursday, Jul 30 · 6:00 PM". */
export function fmtAsOf(date, hoursFromNow) {
  if (hoursFromNow === 0) return "now";
  const today = dayKey.format(new Date());
  const target = dayKey.format(date);
  if (today === target) return `today · ${timeOnly.format(date)}`;
  return `${dayOnly.format(date)} · ${timeOnly.format(date)}`;
}

/** Round to the top of the hour so scrubbing lands on clean times. */
export function hoursFromNow(h) {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + Number(h));
  return d;
}
