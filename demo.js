// Demo mode: a practice league anyone can open and play with - no sign-up, no
// payments, nothing shared. Used by demo.html, demo-admin.html (organiser
// view) and demo-team.html (player view); nothing else loads this file.
//
// How it stays safe: those pages load demo-config.js instead of config.js, so
// they have no database address. db.js then keeps everything in the visitor's
// own browser under its own "pl_demo_" keys. There is no server involved, so
// the demo cannot touch real data, take a payment, or be used to run a real
// league with other people (a link only ever works in the browser that holds
// the demo data). admin.js and team-view.js check for demo mode to hide the
// parts that don't make sense here (new leagues, deleting the league, entry
// fees) and to cap the number of teams.
(function () {
  const cfg = window.LEAGUE_CONFIG || {};
  if (!cfg.demo) return;

  const PREFIX = "pl_demo_";
  const SEED_VERSION = "1"; // bump to give everyone a fresh demo league next visit
  const MAX_TEAMS = 8;
  const LEAGUE_ID = "demo-league";
  const SIGN_UP_URL = "register.html";

  const { el } = window.Render;

  // ---------- storage ----------

  function readTable(table) {
    try {
      return JSON.parse(localStorage.getItem(PREFIX + table) || "[]");
    } catch (e) {
      return [];
    }
  }

  function clearAll() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  }

  // ---------- the practice league ----------

  // A small predictable random-number generator, so the starting league looks
  // the same for everyone.
  function rng(seed) {
    let a = seed;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Three sets, each with a winner - the way every match in this app is scored.
  // `edge` is how much stronger team 1 is (a number, can be negative).
  function playSets(random, edge) {
    const a = [];
    const b = [];
    for (let i = 0; i < 3; i++) {
      const team1Wins = random() < Math.min(0.85, Math.max(0.15, 0.5 + edge * 0.1));
      const tight = random() < 0.25;
      const winner = tight ? 7 : 6;
      const loser = tight ? (random() < 0.5 ? 5 : 6) : Math.floor(random() * 5);
      a.push(team1Wins ? winner : loser);
      b.push(team1Wins ? loser : winner);
    }
    return [a, b];
  }

  function seed() {
    clearAll();
    const random = rng(11);
    let tick = Date.now() - 3 * 24 * 3600 * 1000;
    const stamp = () => new Date((tick += 60000)).toISOString();
    const uid = () => crypto.randomUUID();

    const start = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const rules = window.LeagueRules.build(window.LeagueRules.defaultConfig());
    const league = {
      id: LEAGUE_ID,
      created_at: stamp(),
      name: "Demo Padel League",
      description: "A practice league - nothing here is real.",
      status: "active",
      num_teams: 6,
      num_courts: 2,
      playoff_size: 4,
      start_date: start,
      availability_enabled: true,
      rules
    };

    const names = [
      ["Smash Bros", "Liam Botha", "Noah Pretorius"],
      ["The Lobsters", "Aisha Khan", "Thandi Dlamini"],
      ["Net Gains", "Ruan Jacobs", "Sipho Mokoena"],
      ["Bandeja Bandits", "Chloe Smith", "Megan Naidoo"],
      ["Vibora Vipers", "Zanele Nkosi", "Lerato Molefe"],
      ["Glass Wall Gang", "Daniel Fourie", "Kyle Peters"]
    ];
    const teams = names.map((n, i) => ({
      id: uid(),
      created_at: stamp(),
      league_id: league.id,
      name: n[0],
      player1: n[1],
      player2: n[2],
      access_code: `DEMO${i + 1}X`,
      active: true
    }));
    const strength = Object.fromEntries(teams.map((t, i) => [t.id, 5 - i])); // earlier teams are a bit stronger

    const fixtures = window.Fixtures.generateRoundRobin(teams.map((t) => t.id), league.num_courts).map((f) => ({
      id: uid(),
      created_at: stamp(),
      league_id: league.id,
      ...f
    }));

    const results = [];
    const addResult = (fixture, status, submittedBy, extra) => {
      const [a, b] = playSets(random, strength[fixture.team1_id] - strength[fixture.team2_id]);
      results.push({
        id: uid(),
        created_at: stamp(),
        fixture_id: fixture.id,
        set1_team1_score: a[0], set1_team2_score: b[0],
        set2_team1_score: a[1], set2_team2_score: b[1],
        set3_team1_score: a[2], set3_team2_score: b[2],
        submitted_by_team_id: submittedBy,
        confirmation_status: status,
        superseded: false,
        admin_override: false,
        ...extra
      });
      if (status === "confirmed") fixture.status = "completed";
    };

    const played = fixtures.filter((f) => f.stage === "league" && f.status !== "bye");
    // Weeks 1 and 2 are finished, so the table already has some movement.
    played
      .filter((f) => f.week <= 2)
      .forEach((f) => addResult(f, "confirmed", f.team1_id, { confirmed_by_team_id: f.team2_id, confirmed_at: stamp() }));
    // Week 3 is where there is something to do: Smash Bros (the team the player
    // view starts on) has a score waiting for its OK, one other score is
    // waiting for the organiser to look at, and one is disputed.
    const week3 = played.filter((f) => f.week === 3);
    const mine = week3.find((f) => f.team1_id === teams[0].id || f.team2_id === teams[0].id);
    const others = week3.filter((f) => f !== mine);
    if (mine) addResult(mine, "pending", mine.team1_id === teams[0].id ? mine.team2_id : mine.team1_id);
    if (others[0]) addResult(others[0], "pending", others[0].team1_id);
    if (others[1]) addResult(others[1], "disputed", others[1].team1_id, { dispute_reason: "We think the second set was won by us.", disputed_at: stamp() });

    // Every team has already accepted the rules, so the player view opens straight on the dashboard.
    const acceptances = teams.map((t) => ({
      id: uid(),
      created_at: stamp(),
      league_id: league.id,
      team_id: t.id,
      accepted_name: t.player1,
      rules_snapshot: rules.items
    }));

    const tables = { leagues: [league], teams, fixtures, results, rules_acceptances: acceptances, availability: [] };
    Object.entries(tables).forEach(([name, rows]) => localStorage.setItem(PREFIX + name, JSON.stringify(rows)));
    localStorage.setItem(PREFIX + "seed_version", SEED_VERSION);
  }

  let storageError = null;
  try {
    if (localStorage.getItem(PREFIX + "seed_version") !== SEED_VERSION || !readTable("leagues").length) seed();
  } catch (e) {
    storageError = e;
  }

  // ---------- simulate the next week / playoff round ----------

  // Plays the next batch of matches with made-up scores: the next unplayed
  // week of the league, or - once the league stage is done and the playoffs
  // have been started - the next knockout round. Returns a sentence saying
  // what happened (or what to do next).
  async function simulateNext() {
    const { dbList } = window.DB;
    const [league] = await dbList("leagues");
    const [teams, fixtures] = await Promise.all([dbList("teams"), dbList("fixtures")]);
    const strength = Object.fromEntries(teams.map((t, i) => [t.id, teams.length - i]));
    const open = (f) => f.status !== "bye" && f.status !== "completed" && f.team1_id && f.team2_id;

    if (!fixtures.length) return "There are no fixtures yet - open Fixtures and tap Generate fixtures first.";

    let batch = [];
    let label = "";
    const leagueOpen = fixtures.filter((f) => f.stage === "league" && open(f));
    if (leagueOpen.length) {
      const week = Math.min(...leagueOpen.map((f) => f.week));
      batch = leagueOpen.filter((f) => f.week === week);
      label = `week ${week}`;
    } else {
      for (const stage of window.Playoffs.STAGE_ORDER || ["QF", "SF", "F"]) {
        batch = fixtures.filter((f) => f.stage === stage && open(f));
        if (batch.length) {
          label = { QF: "the quarter-finals", SF: "the semi-finals", F: "the final" }[stage] || stage;
          break;
        }
      }
    }
    if (!batch.length) {
      if (league && league.status === "completed") return "The league is finished - use Reset demo to start again.";
      return "The league stage is finished. Open Playoffs and tap Start playoffs, then simulate again.";
    }
    for (const f of batch) {
      const [a, b] = playSets(Math.random, strength[f.team1_id] - strength[f.team2_id]);
      await window.Results.adminSetResult(f, null, a, b);
    }
    return `Played ${label}.`;
  }

  // ---------- the bar across the top of every demo page ----------

  function reset() {
    try {
      seed();
    } catch (e) {
      /* the page will show the storage warning */
    }
    // Drop any league/week in the address (ids are the same after a reset,
    // but a half-finished form or open row should go too).
    history.replaceState(null, "", location.pathname + location.search);
    location.reload();
  }

  function buildBar() {
    const page = location.pathname.split("/").pop();
    const isTeamPage = page === "demo-team.html";
    const message = el("span", { class: "demo-msg", role: "status" }, "");
    const say = (text) => {
      message.textContent = text;
    };

    const simulate = el("button", { class: "btn btn-ghost small", type: "button" }, "Simulate next week");
    simulate.addEventListener("click", async () => {
      simulate.disabled = true;
      say("");
      try {
        const text = await simulateNext();
        say(text);
        if (/^Played/.test(text)) setTimeout(() => location.reload(), 500);
      } catch (err) {
        console.error(err);
        say("That didn't work - try Reset demo.");
      }
      simulate.disabled = false;
    });

    const resetBtn = el("button", { class: "btn btn-ghost small", type: "button" }, "Reset demo");
    resetBtn.addEventListener("click", () => {
      if (confirm("Reset the demo? Everything you changed is cleared and the practice league starts over.")) reset();
    });

    // Switch between the organiser's view and a player's view; in the player's
    // view a picker lets you "be" any team (e.g. submit a score as one team,
    // then confirm it as the other).
    const views = [
      el("a", { class: `demo-view${isTeamPage ? "" : " active"}`, href: "demo-admin.html" }, "Organiser view"),
      el("a", { class: `demo-view${isTeamPage ? " active" : ""}`, href: "demo-team.html" }, "Player view")
    ];

    let picker = null;
    if (isTeamPage) {
      const current = (new URLSearchParams(location.search).get("code") || "DEMO1X").toUpperCase();
      picker = el(
        "select",
        { class: "input demo-picker", "aria-label": "Which team you are" },
        readTable("teams").map((t) => el("option", { value: t.access_code, selected: t.access_code === current ? "selected" : undefined }, `You are: ${t.name}`))
      );
      picker.addEventListener("change", () => {
        location.href = `demo-team.html?code=${encodeURIComponent(picker.value)}`;
      });
    }

    const bar = el("div", { class: "demo-bar" }, [
      el("div", { class: "demo-bar-top" }, [
        el("span", { class: "demo-tag" }, "Demo"),
        el("span", { class: "demo-text" }, "Practice league - nothing here is real."),
        el("a", { class: "btn btn-primary small demo-cta", href: SIGN_UP_URL }, "Start a league")
      ]),
      el("div", { class: "demo-bar-actions" }, [...views, picker, simulate, resetBtn, message])
    ]);
    if (storageError) {
      bar.appendChild(el("p", { class: "demo-warn" }, "This browser is blocking storage, so the demo can't save anything. Turn off private browsing or allow site data and reload."));
    }

    const header = document.querySelector(".app-header");
    if (header) header.insertAdjacentElement("afterend", bar);
    else document.body.prepend(bar);
  }

  window.Demo = { isDemo: true, MAX_TEAMS, LEAGUE_ID, SIGN_UP_URL, simulateNext, reset, buildBar };

  // demo.html (the front door) builds its own page, so the bar is only
  // added on the two working pages.
  if (/demo-(admin|team)\.html$/.test(location.pathname)) buildBar();

  // The player view opens on the first team unless a team was chosen.
  if (/demo-team\.html$/.test(location.pathname) && !new URLSearchParams(location.search).get("code")) {
    history.replaceState(null, "", `${location.pathname}?code=DEMO1X`);
  }
})();
