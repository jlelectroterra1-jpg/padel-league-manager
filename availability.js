// Team availability board - pure week/date helpers plus the write path for
// saving a team's weekly slots. Kept separate from DOM glue so the date math
// can be sanity-checked directly in Node, same convention as fixtures.js/
// playoffs.js/standings.js.
//
// Data shape: one row per (team_id, week_start) in the `availability` table -
// week_start is always the Monday (ISO date string) of the week it applies
// to, `slots` is a small JSON array of {day, start, end} ("day" is one of
// DAYS, "start"/"end" are "HH:MM" 24h strings from <input type="time">), and
// `note` is a single optional short string for that week. A slot can also
// carry an optional `toDay` for a day-RANGE entry ("Mon" to "Fri" instead of
// a single day) - a plain slot with no toDay is exactly the old shape, so
// every slot saved before day ranges existed is still valid, no migration
// needed. Nothing here reads or duplicates team/player names - callers join
// against the team record they already have, same as everywhere else in
// the app.
(function (root) {
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DAY_LABELS = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function isoDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Monday (local midnight) of the ISO week containing `d` (defaults to now).
  function weekStartDate(d) {
    d = d || new Date();
    const day = d.getDay(); // 0 = Sun .. 6 = Sat
    const diff = day === 0 ? -6 : 1 - day;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  }

  function currentWeekStartISO(d) {
    return isoDate(weekStartDate(d));
  }

  // "21 Sep - 27 Sep" from a week_start ISO date string.
  function formatWeekRange(weekStartISO) {
    const start = new Date(weekStartISO + "T00:00:00");
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const opts = { day: "numeric", month: "short" };
    return `${start.toLocaleDateString(undefined, opts)} - ${end.toLocaleDateString(undefined, opts)}`;
  }

  // "Mon-Fri" for a day-range slot, or just "Mon" for a plain single-day
  // slot - the compact label shown wherever a slot is displayed.
  function slotDayLabel(slot) {
    if (!slot.toDay || slot.toDay === slot.day) return slot.day;
    return `${slot.day}-${slot.toDay}`;
  }

  // Expands a slot into one {day,start,end} entry per day it covers - a
  // plain single-day slot expands to just itself; a day-range slot expands
  // to one entry per day from slot.day to slot.toDay inclusive (DAYS order,
  // Mon..Sun, no wraparound). Invalid/reversed ranges fall back to treating
  // it as a single day rather than throwing, since this only feeds display/
  // future matching, never validation (that happens before a slot is ever
  // saved - see availabilityEditForm in team-view.js).
  function expandSlot(slot) {
    const from = DAYS.indexOf(slot.day);
    const to = slot.toDay ? DAYS.indexOf(slot.toDay) : from;
    if (from === -1 || to === -1 || to < from) return [{ day: slot.day, start: slot.start, end: slot.end }];
    const out = [];
    for (let i = from; i <= to; i++) out.push({ day: DAYS[i], start: slot.start, end: slot.end });
    return out;
  }

  // The row for this team/week, if any. Defensively takes the most recently
  // updated match in case a rare double-save ever leaves more than one (the
  // DB also has a unique(team_id, week_start) constraint to prevent this).
  function forTeamWeek(teamId, weekStartISO, rows) {
    const matches = (rows || []).filter((r) => r.team_id === teamId && r.week_start === weekStartISO);
    if (!matches.length) return null;
    return matches.slice().sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))[0];
  }

  async function saveAvailability({ existingId, teamId, leagueId, weekStart, slots, note }) {
    const payload = { slots, note: note || null, updated_at: new Date().toISOString() };
    if (existingId) return window.DB.dbUpdate("availability", existingId, payload);
    return window.DB.dbInsert("availability", { team_id: teamId, league_id: leagueId, week_start: weekStart, ...payload });
  }

  const Availability = {
    DAYS,
    DAY_LABELS,
    isoDate,
    weekStartDate,
    currentWeekStartISO,
    formatWeekRange,
    slotDayLabel,
    expandSlot,
    forTeamWeek,
    saveAvailability
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Availability;
  else root.Availability = Availability;
})(typeof window !== "undefined" ? window : globalThis);
