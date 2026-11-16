// League rules: the platform's base set of rules, and how a league's chosen
// version of them is turned into the final text teams read and accept.
// Pure logic - no fetch, no DOM - same shape as fixtures.js/standings.js,
// so it can be unit-tested directly in Node.
//
// A rule is either LOCKED (always part of every league's rules - these
// describe how the app itself actually works, so unticking one wouldn't
// change what the app does) or optional (the organiser can untick it, and
// fill in its {blanks}). On top of that the organiser can add their own
// free-text rules.
//
// The league stores both the editor state (`config`, so the rules can be
// re-edited) and the FINAL rendered text (`items`). Teams see and accept
// `items`, never a live re-render from this file - so changing the base set
// here later can never silently change what a league's teams agreed to.
(function (root) {
  const BASE_RULES = [
    // ---------- Locked ----------
    { key: "format", group: "Format and scoring", locked: true, text: "The league is a round-robin: every team plays every other team once, in weekly rounds." },
    { key: "scoring", group: "Format and scoring", locked: true, text: "Every match has 3 sets, and each set must have a winner. Every set won is worth 1 league point." },
    { key: "table", group: "Format and scoring", locked: true, text: "The league table is ranked by points, then set difference, then sets won." },
    { key: "submit", group: "Results", locked: true, text: "After a match, one team submits the score in the app and the opposing team confirms it." },
    { key: "disputes", group: "Results", locked: true, text: "A disputed score is decided by the organiser, whose decision is final. The organiser can also correct or confirm a score." },
    { key: "private-link", group: "Results", locked: true, text: "Anyone with a team's private link can submit or confirm results for that team, so keep your link private." },
    { key: "forfeit", group: "Forfeits and playoffs", locked: true, text: "A team that forfeits earns 0 points. The opponent gets the win and 2 league points, and no set scores are recorded." },
    { key: "playoffs", group: "Forfeits and playoffs", locked: true, text: "After the league stage, the top teams (the number is set by the organiser) go into the playoffs, seeded by the table. Playoffs earn no league points, and a forfeit in a playoff match sends the opponent through." },

    // Always applies, so it's locked rather than an optional extra.
    { key: "court-fees", group: "Court fees", locked: true, text: "Court fees are paid separately, directly to the court, when the court is booked on the Playtomic app." },

    // Entry-fee rules: part of the agreed base set, but only added to a
    // league that actually charges an entry fee (render/build's `payments`
    // option) - teams shouldn't be told about a fee that isn't there.
    { key: "entry-fee", group: "Entry fee", locked: true, onlyWhen: "payments", text: "The entry fee is shown on your team link and is paid once per team, covering both partners. A team is registered only once its fee is paid, by the cut-off date set by the organiser." },
    { key: "refunds", group: "Entry fee", locked: true, onlyWhen: "payments", text: "Refunds for withdrawn teams are handled by the organiser." },

    // ---------- Optional, on by default ----------
    { key: "score-window", group: "Match play", defaultOn: true, params: { submitHours: 48, confirmHours: 48 }, text: "Scores must be submitted within {submitHours} hours of the match, and the opponent must confirm within {confirmHours} hours. After that the organiser may confirm the score." },
    { key: "round-week", group: "Match play", defaultOn: true, text: "Each round's matches must be played within that round's week. Matches not played may be recorded as forfeits at the organiser's discretion." },
    { key: "late", group: "Match play", defaultOn: true, params: { lateMinutes: 15 }, text: "A team not ready within {lateMinutes} minutes of the agreed start time forfeits the match." },
    { key: "cancellation", group: "Match play", defaultOn: true, params: { noticeHours: 24, noShows: 2 }, text: "Cancellations need at least {noticeHours} hours' notice. Repeated no-shows ({noShows}) can mean removal from the league." },
    { key: "deuce", group: "Match play", defaultOn: true, text: "Game scoring: deuce, one advantage, then golden point." },
    { key: "withdrawal", group: "Match play", defaultOn: true, params: { withdrawalPoint: "the halfway point" }, text: "A team that withdraws before {withdrawalPoint} has its results voided. After that, results stand." },
    { key: "conduct", group: "Conduct", defaultOn: true, text: "Players must behave respectfully on and off the court. The organiser may remove a team for serious misconduct." },

    // ---------- Optional, off by default ----------
    { key: "balls", group: "Extras", defaultOn: false, text: "Teams provide their own balls." },
    { key: "substitutes", group: "Extras", defaultOn: false, text: "Substitutes are allowed for one partner with the organiser's approval, but not in playoffs." },
    { key: "playtomic", group: "Extras", defaultOn: false, text: "Teams must also update the match score on Playtomic." }
  ];

  // Editor state with nothing changed: every optional rule at its default,
  // blanks at their defaults, no custom rules.
  function defaultConfig() {
    return { items: {}, custom: [] };
  }

  function isOn(rule, config) {
    if (rule.locked) return true;
    const entry = config.items && config.items[rule.key];
    return entry && entry.on !== undefined ? !!entry.on : !!rule.defaultOn;
  }

  function fillText(rule, config) {
    const entry = (config.items && config.items[rule.key]) || {};
    const values = entry.values || {};
    return rule.text.replace(/\{(\w+)\}/g, (match, name) => {
      const v = values[name];
      const filled = v === undefined || v === null ? "" : String(v).trim();
      return filled === "" ? String(rule.params[name]) : filled;
    });
  }

  // Turns an editor config into the final, ordered list of rule texts.
  // options.payments = true adds the rules that only make sense when the
  // league charges an entry fee.
  function render(config, options) {
    config = config || defaultConfig();
    options = options || {};
    const items = [];
    BASE_RULES.forEach((rule) => {
      if (rule.onlyWhen && !options[rule.onlyWhen]) return;
      if (!isOn(rule, config)) return;
      items.push({ key: rule.key, locked: !!rule.locked, text: fillText(rule, config) });
    });
    (config.custom || [])
      .map((line) => String(line).trim())
      .filter(Boolean)
      .forEach((text, i) => items.push({ key: `custom-${i + 1}`, locked: false, text }));
    return items;
  }

  // What gets stored on leagues.rules.
  function build(config, options) {
    config = config || defaultConfig();
    return { config, items: render(config, options) };
  }

  // Splits a rule's text into plain text and {blank} parts, so an editor can
  // show the blanks as inline inputs: [{text}, {param, value}, {text}, ...]
  function parts(rule) {
    const out = [];
    const re = /\{(\w+)\}/g;
    let last = 0;
    let m;
    while ((m = re.exec(rule.text))) {
      if (m.index > last) out.push({ text: rule.text.slice(last, m.index) });
      out.push({ param: m[1], value: rule.params[m[1]] });
      last = m.index + m[0].length;
    }
    if (last < rule.text.length) out.push({ text: rule.text.slice(last) });
    return out;
  }

  const LeagueRules = { BASE_RULES, defaultConfig, render, build, parts, isOn };
  if (typeof module !== "undefined" && module.exports) module.exports = LeagueRules;
  else root.LeagueRules = LeagueRules;
})(typeof window !== "undefined" ? window : globalThis);
