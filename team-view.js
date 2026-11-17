// Team dashboard: resolves ?code=... (or a remembered code) to a team, then
// shows that team's fixtures with score submission / confirmation / dispute.
// Write-path logic lives in results.js - this file is DOM glue only.
(function () {
  const { el, qs, formatDate, scoreGrid, scoreInput, wireAutoAdvance, rulesList, postForm } = window.Render;
  const { dbList, dbInsert } = window.DB;

  const app = document.getElementById("app");
  const openSubmitForms = new Set();
  const expandedAvail = new Set();
  let availabilityEditing = false;
  let ctx = null; // { team, league, teamsById, fixtures, results, availability }

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    app.appendChild(window.Render.skeleton());
    const codeFromUrl = qs("code");
    if (codeFromUrl) window.State.rememberTeamCode(codeFromUrl.toUpperCase());
    const code = (codeFromUrl || window.State.getRememberedTeamCode() || "").toUpperCase();

    if (code) upgradeUrlToCleanPath(code);

    if (!code) {
      renderNoCode();
      return;
    }

    try {
      await loadAndRender(code);
    } catch (err) {
      console.error(err);
      app.innerHTML = "";
      app.appendChild(el("div", { class: "card" }, [el("h3", {}, "Something went wrong"), el("p", { class: "muted" }, String(err.message || err))]));
    }
  }

  // Old team.html?code=XXX links (and the 404.html handoff for a clean
  // .../team/XXX or .../t/XXX link opened directly) both land here with the
  // code in the query string - rewrite the address bar to the clean
  // .../team/XXX form without reloading, so it always matches what "Copy
  // Team Link" in admin hands out, however the page was actually reached.
  function upgradeUrlToCleanPath(code) {
    if (window.LEAGUE_CONFIG && window.LEAGUE_CONFIG.demo) return; // the demo keeps its own link form
    if (!window.history || !window.history.replaceState) return;
    const cleanPath = location.pathname.replace(/team\.html$/, "") + "team/" + code;
    if (location.pathname === cleanPath && !location.search) return;
    history.replaceState(null, "", location.origin + cleanPath);
  }

  function renderNoCode() {
    const input = el("input", { class: "input", placeholder: "Enter your team code" });
    const form = el("form", { class: "card" }, [
      el("h2", {}, "Enter your team code"),
      el("p", { class: "muted" }, "Ask your league admin for your team's link or access code."),
      input,
      el("button", { class: "btn btn-primary", type: "submit" }, "Continue")
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = input.value.trim().toUpperCase();
      if (!code) return;
      window.State.rememberTeamCode(code);
      location.reload();
    });
    app.innerHTML = "";
    app.appendChild(form);
  }

  // Only used on first load (from the URL/remembered code) - every reload
  // after an in-app action goes through refresh() instead, which skips this
  // lookup entirely. Re-resolving the team by access_code on every action
  // was a full extra network round trip (~0.5-0.75s measured) for data we
  // already had in memory - the team never changes mid-session.
  async function loadAndRender(code) {
    const teams = await dbList("teams", { access_code: `eq.${code}` });
    const team = teams[0];
    if (!team) {
      app.innerHTML = "";
      app.appendChild(
        el("div", { class: "card" }, [
          el("h3", {}, "Team code not recognised"),
          el("p", { class: "muted" }, "Double-check the link or code your league admin sent you."),
          el(
            "button",
            { class: "btn btn-ghost", type: "button", onclick: () => { window.State.forgetTeamCode(); location.reload(); } },
            "Try a different code"
          )
        ])
      );
      return;
    }
    installTeamShortcut(team);
    await loadLeagueData(team);
  }

  // "Add to Home Screen" from a team link should open THAT team's page, not
  // the front page - so the page builds its own small manifest whose start
  // page is this team's link (the same link the player is on right now), and
  // names the shortcut after the team. Purely cosmetic: if anything here
  // isn't supported, the page just works as it always did.
  function installTeamShortcut(team) {
    if (window.LEAGUE_CONFIG && window.LEAGUE_CONFIG.demo) return; // nothing to install for the demo
    try {
      document.title = `${team.name} - Padel League Manager`;
      const head = document.head;
      const setMeta = (name, content) => {
        let m = head.querySelector(`meta[name="${name}"]`);
        if (!m) {
          m = document.createElement("meta");
          m.name = name;
          head.appendChild(m);
        }
        m.content = content;
      };
      setMeta("apple-mobile-web-app-title", team.name.length > 14 ? team.name.slice(0, 13) + "…" : team.name);

      const base = location.origin + location.pathname.replace(/(?:team|t)\/[^/]+\/?$/, "").replace(/team\.html$/, "");
      const link = location.origin + location.pathname;
      const manifest = {
        id: link,
        name: `${team.name} - Padel League`,
        short_name: team.name.length > 12 ? team.name.slice(0, 11) + "…" : team.name,
        start_url: link,
        scope: base,
        display: "standalone",
        background_color: "#14213D",
        theme_color: "#14213D",
        icons: [
          { src: base + "assets/logo-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: base + "assets/logo-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: base + "assets/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      };
      let el2 = head.querySelector('link[rel="manifest"]');
      if (!el2) {
        el2 = document.createElement("link");
        el2.rel = "manifest";
        head.appendChild(el2);
      }
      el2.href = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" }));
    } catch (e) {
      /* not supported - nothing to do */
    }
  }

  // Re-fetches everything about the current league/team without re-resolving
  // the team from its access code - call this (not loadAndRender) after any
  // in-app action (submit/confirm/dispute/availability save).
  async function refresh() {
    await loadLeagueData(ctx.team);
  }

  async function loadLeagueData(team) {
    // Has the organiser paid the R50 to activate this league? Most leagues
    // (every league from before activation existed) have no such requirement.
    // "none" and "paid" can't go back, so once seen they are reused on later
    // refreshes (refresh() is deliberately light); "unpaid" is re-checked.
    const cachedActivation =
      ctx && ctx.team && ctx.team.id === team.id && ctx.activationState && ctx.activationState !== "unpaid" ? ctx.activationState : null;
    // What we already know about this team from an earlier load (null on the
    // very first one). On the first load the rules acceptance and the payment
    // are fetched in the SAME round of requests as everything else - asking
    // for them afterwards, one after the other, made the page wait for three
    // separate trips to the database before showing anything.
    const known = ctx && ctx.team && ctx.team.id === team.id ? ctx : null;
    const wantAccepted = !known || (!!(known.league && known.league.rules) && !known.accepted);
    const wantPayment = !known || (window.EntryFee.leagueHasFee(known.league) && !(known.payment && known.payment.status === "complete"));
    const [league, allTeams, fixtures, results, availability, activationRows, acceptedRows, paymentRows] = await Promise.all([
      dbList("leagues", { id: `eq.${team.league_id}` }).then((r) => r[0]),
      dbList("teams", { league_id: `eq.${team.league_id}` }),
      dbList("fixtures", { league_id: `eq.${team.league_id}` }),
      // Scoped to this league's fixtures via Supabase's join-filter syntax,
      // instead of fetching every league's results and filtering client
      // side - the old dbList("results") pulled the whole table on every
      // load, growing forever as any league (not just this one) plays more
      // matches.
      dbList("results", { select: "*,fixtures!inner(id)", "fixtures.league_id": `eq.${team.league_id}` }),
      dbList("availability", { league_id: `eq.${team.league_id}` }),
      cachedActivation ? Promise.resolve([]) : dbList("league_activation_status", { league_id: `eq.${team.league_id}` }),
      wantAccepted ? dbList("rules_acceptances", { team_id: `eq.${team.id}` }) : Promise.resolve(null),
      wantPayment ? dbList("team_payment_status", { team_id: `eq.${team.id}` }) : Promise.resolve(null)
    ]);
    const activationState = cachedActivation || (!activationRows[0] ? "none" : activationRows[0].paid ? "paid" : "unpaid");
    const teamsById = Object.fromEntries(allTeams.map((t) => [t.id, t]));
    // Re-resolve from the just-fetched teams list (by id) rather than
    // trusting the possibly-stale `team` passed in - keeps e.g. a name
    // change made elsewhere in the league picked up on every refresh.
    const freshTeam = teamsById[team.id] || team;

    // League not activated yet: nothing else is shown (or looked up).
    if (activationState === "unpaid") {
      ctx = { team: freshTeam, league, teamsById, fixtures, results, availability, accepted: null, payment: null, activationState };
      render();
      return;
    }

    // Only a league that has rules asks its teams to accept them - a league
    // without any (every league created before rules existed) skips this
    // lookup entirely and behaves exactly as it always has. An acceptance
    // can never be undone, so once we have this team's, every later refresh
    // (after each score action) reuses it instead of re-fetching - refresh()
    // was deliberately made fast, so this must not add a request back.
    let accepted = null;
    if (league && league.rules) {
      accepted =
        ctx && ctx.accepted && ctx.team && ctx.team.id === freshTeam.id
          ? ctx.accepted
          : (acceptedRows || (await dbList("rules_acceptances", { team_id: `eq.${freshTeam.id}` })))[0] || null;
    }

    // Only a league that charges an entry fee has payments to look up, and
    // only once the rules (if any) are accepted - the payment screen comes
    // after them. Free leagues (every league created before entry fees
    // existed) skip this entirely. A completed payment never goes back, so
    // once seen it is reused on later refreshes.
    let payment = null;
    if (window.EntryFee.leagueHasFee(league) && (!league.rules || accepted)) {
      payment =
        ctx && ctx.payment && ctx.payment.status === "complete" && ctx.team && ctx.team.id === freshTeam.id
          ? ctx.payment
          : latestPayment(paymentRows || (await dbList("team_payment_status", { team_id: `eq.${freshTeam.id}` })));
    }

    ctx = { team: freshTeam, league, teamsById, fixtures, results, availability, accepted, payment, activationState };
    render();
  }

  // The payment that matters for this team: a completed one wins, then a
  // pending one, then the most recent of whatever else (failed, refunded...).
  function latestPayment(rows) {
    return rows.find((p) => p.status === "complete") || rows.find((p) => p.status === "pending") || rows[rows.length - 1] || null;
  }

  // This is a single continuous page (no tabs/routing), so every render() is
  // an in-place update from some action (toggling a score form, confirming a
  // result) - always restore scroll position rather than letting a full DOM
  // rebuild silently reset it to the top.
  function render() {
    const scrollY = window.scrollY;
    const { team, league, teamsById, fixtures, results } = ctx;
    const allTeams = Object.values(teamsById);
    app.innerHTML = "";
    app.classList.remove("with-nav");

    // An organiser's league that hasn't paid its R50 isn't open to teams yet.
    if (ctx.activationState === "unpaid") {
      stopPaymentPolling();
      app.appendChild(notOpenCard(league));
      window.scrollTo(0, 0);
      return;
    }

    // First thing a team sees on a league that has rules: read and accept
    // them. The dashboard below only renders once they have.
    if (league && league.rules && !ctx.accepted) {
      stopPaymentPolling();
      app.appendChild(rulesGate(league, team));
      window.scrollTo(0, 0);
      return;
    }

    // Then, on a league with an entry fee, the fee. The dashboard only
    // appears once the team's payment has been confirmed by PayFast.
    if (window.EntryFee.leagueHasFee(league) && !(ctx.payment && ctx.payment.status === "complete")) {
      app.appendChild(paymentGate(league, team));
      window.scrollTo(0, 0);
      return;
    }
    stopPaymentPolling();

    const standings = window.Standings.computeStandings(allTeams, fixtures, results);
    const myRow = standings.find((r) => r.team.id === team.id);
    const hasRules = !!(league && league.rules && ctx.accepted);
    const todo = needsMyConfirmation();

    // The page is split into sections (one at a time, with a bar to switch):
    // a phone gets a bottom bar like an app, wider screens a bar at the top.
    const sections = [
      { id: "home", label: "Home", icon: "home" },
      { id: "matches", label: "Matches", icon: "calendar", dot: todo.length > 0 },
      { id: "table", label: "Table", icon: "trophy" },
      { id: "availability", label: "Availability", icon: "clock" }
    ];
    if (hasRules) sections.push({ id: "rules", label: "Rules", icon: "doc" });
    if (!sections.some((x) => x.id === section)) section = "home";

    const builders = {
      home: () => homeSection(standings, myRow, todo),
      matches: () => matchesSection(),
      table: () => tableSection(standings),
      availability: () => [availabilityCard()],
      rules: () => rulesSection()
    };

    app.classList.add("with-nav");
    app.appendChild(sectionNav(sections));
    const body = el("div", { class: "team-section" });
    builders[section]().forEach((node) => node && body.appendChild(node));
    app.appendChild(body);

    window.scrollTo(0, scrollY);
  }

  // ---------- Sections ----------

  // Which section is showing. Remembered for this browser tab only, so
  // coming back after confirming a score leaves you where you were. Storage
  // can be blocked (private mode), so every use is guarded.
  let section = (function () {
    try {
      return sessionStorage.getItem("pl_team_section") || "home";
    } catch (e) {
      return "home";
    }
  })();

  function setSection(id) {
    section = id;
    try {
      sessionStorage.setItem("pl_team_section", id);
    } catch (e) {
      /* fine - it just won't be remembered */
    }
    render();
    window.scrollTo(0, 0);
  }

  function sectionNav(sections) {
    return el(
      "nav",
      { class: "team-nav", "aria-label": "Team page sections" },
      sections.map((x) =>
        el(
          "button",
          {
            class: `team-nav-item${section === x.id ? " active" : ""}`,
            type: "button",
            "aria-current": section === x.id ? "page" : undefined,
            onclick: () => setSection(x.id)
          },
          [window.Render.icon(x.icon, 22), el("span", { class: "team-nav-label" }, x.label), x.dot ? el("span", { class: "nav-dot", title: "Needs your attention" }) : null]
        )
      )
    );
  }

  // Fixtures where the opponent has submitted a score and this team still
  // needs to confirm or dispute it.
  function needsMyConfirmation() {
    const { team, fixtures, results } = ctx;
    return fixtures.filter((f) => {
      if (f.status === "bye" || (f.team1_id !== team.id && f.team2_id !== team.id)) return false;
      const r = window.Results.activeResultForFixture(f.id, results);
      return !!r && r.confirmation_status === "pending" && r.submitted_by_team_id !== team.id;
    });
  }

  function myLeagueFixtures() {
    const { team, fixtures } = ctx;
    return fixtures.filter((f) => f.stage === "league" && (f.team1_id === team.id || f.team2_id === team.id));
  }

  function homeSection(standings, myRow, todo) {
    const { team, league, teamsById, fixtures, results } = ctx;
    const nodes = [];

    if (league && (league.status === "completed" || league.status === "archived")) {
      nodes.push(championCard(fixtures, results, teamsById));
    }

    // Visual hierarchy, strongest to weakest: MY team name > where I stand >
    // stats > what to do next > the opponent. The page must read as "this is
    // MY dashboard" before anything else.
    const confirmedIds = new Set(results.filter((r) => r.confirmation_status === "confirmed" && !r.superseded).map((r) => r.fixture_id));
    const playable = myLeagueFixtures().filter((f) => f.status !== "bye");
    const playedCount = playable.filter((f) => confirmedIds.has(f.id)).length;

    nodes.push(
      el("div", { class: "card team-hero" }, [
        el("div", { class: "hero-eyebrow" }, league ? league.name : ""),
        el("div", { class: "my-team-label" }, "Your team"),
        el("h2", {}, team.name),
        el("p", { class: "muted" }, `${team.player1} + ${team.player2}`),
        myRow
          ? el("div", { class: "hero-rank" }, [el("div", { class: "rank-badge" }, ordinal(myRow.position)), el("div", { class: "muted small" }, `of ${standings.length} teams`)])
          : null,
        myRow
          ? el("div", { class: "summary-grid" }, [statTile("Played", myRow.played), statTile("Won", myRow.won), statTile("Lost", myRow.lost), statTile("Points", myRow.pts)])
          : null,
        playable.length
          ? el("div", { class: "progress-wrap" }, [
              el("div", { class: "muted small" }, `${playedCount} of ${playable.length} matches played`),
              el("div", { class: "progress" }, el("span", { style: `width:${Math.round((playedCount / playable.length) * 100)}%` }))
            ])
          : null
      ])
    );

    if (todo.length) {
      nodes.push(
        el("div", { class: "card attention-card" }, [
          el("h3", {}, [window.Render.icon("alert", 20), "Needs your attention"]),
          el("p", { class: "muted small" }, todo.length === 1 ? "Your opponent has submitted a score. Check it, then confirm or dispute it." : "Your opponents have submitted scores. Check them, then confirm or dispute them."),
          el("div", { class: "stack" }, todo.map((f) => fixtureRow(f)))
        ])
      );
    }

    const next = window.Fixtures.nextFixtureForTeam(team.id, fixtures, results);
    if (next) {
      nodes.push(nextMatchCard(next));
    } else if (playable.length) {
      nodes.push(el("div", { class: "card" }, window.Render.emptyState("check", "You've played all your league matches. Check the Table for where you finished.")));
    } else {
      nodes.push(el("div", { class: "card" }, window.Render.emptyState("calendar", "Your fixtures haven't been set yet - check back once your organiser sets the schedule.")));
    }
    return nodes;
  }

  // The next match, with the one action that matters for it.
  function nextMatchCard(next) {
    const { team, teamsById, results } = ctx;
    const oppId = next.team1_id === team.id ? next.team2_id : next.team1_id;
    const opp = teamsById[oppId];
    const isTeam1 = next.team1_id === team.id;
    const result = window.Results.activeResultForFixture(next.id, results);

    const children = [
      el("div", { class: "next-eyebrow" }, `Your next match · Week ${next.week}`),
      el("div", { class: "next-opp" }, opp ? opp.name : "Opponent to be decided"),
      opp ? el("div", { class: "opp-players" }, `${opp.player1} & ${opp.player2}`) : null,
      opponentAvailabilitySummary(opp, "next")
    ];

    if (!result) {
      const open = openSubmitForms.has(next.id);
      children.push(
        el("button", { class: `btn block ${open ? "btn-ghost" : "btn-primary"}`, type: "button", onclick: () => toggleSubmitForm(next.id) }, open ? "Cancel" : "Submit result")
      );
      if (open) children.push(submitForm(next, isTeam1, opp));
    } else if (result.confirmation_status === "disputed") {
      children.push(el("div", { class: "next-status" }, "This result is disputed. Your organiser will decide it."));
    } else if (result.submitted_by_team_id === team.id) {
      const sw = window.Standings.setsWon(result);
      const mine = isTeam1 ? sw.team1 : sw.team2;
      const theirs = isTeam1 ? sw.team2 : sw.team1;
      children.push(el("div", { class: "next-status" }, `You submitted ${mine}-${theirs}. Waiting for ${opp ? opp.name : "your opponent"} to confirm it.`));
    } else {
      children.push(el("div", { class: "next-status" }, "Your opponent has submitted a score - confirm or dispute it above."));
    }
    return el("div", { class: "card next-card" }, children);
  }

  // All of this team's matches, grouped by what needs doing.
  function matchesSection() {
    const { team, fixtures, results, teamsById } = ctx;
    const nodes = [];
    const groups = { confirm: [], toPlay: [], waiting: [], disputed: [], played: [] };

    myLeagueFixtures()
      .sort((a, b) => a.week - b.week)
      .forEach((f) => {
        if (f.status === "bye") return groups.toPlay.push(f);
        const r = window.Results.activeResultForFixture(f.id, results);
        if (!r) groups.toPlay.push(f);
        else if (r.confirmation_status === "confirmed") groups.played.push(f);
        else if (r.confirmation_status === "disputed") groups.disputed.push(f);
        else if (r.confirmation_status === "pending" && r.submitted_by_team_id !== team.id) groups.confirm.push(f);
        else groups.waiting.push(f);
      });

    const group = (title, list, extraClass) =>
      list.length
        ? el("div", { class: `card ${extraClass || ""}` }, [
            el("h3", { class: "group-title" }, [title, el("span", { class: "group-count" }, String(list.length))]),
            el("div", { class: "stack" }, list.map((f) => fixtureRow(f)))
          ])
        : null;

    if (!myLeagueFixtures().length) {
      nodes.push(el("div", { class: "card" }, window.Render.emptyState("calendar", "Fixtures haven't been generated yet - check back once your organiser sets the schedule.")));
    } else {
      nodes.push(group("Needs your confirmation", groups.confirm, "attention-card"));
      nodes.push(group("To play", groups.toPlay));
      nodes.push(group("Waiting for your opponent", groups.waiting));
      nodes.push(group("Disputed - your organiser decides", groups.disputed));
      nodes.push(group("Played", groups.played));
    }

    const myPlayoffFixtures = fixtures.filter((f) => f.stage !== "league" && (f.team1_id === team.id || f.team2_id === team.id));
    if (myPlayoffFixtures.length) {
      const stageOrder = { QF: 0, SF: 1, F: 2 };
      nodes.push(
        el("div", { class: "card" }, [
          el("h3", {}, "My playoff matches"),
          el("div", { class: "stack" }, myPlayoffFixtures.sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage]).map((f) => fixtureRow(f)))
        ])
      );
    }

    const confirmedFixtureIds = new Set(results.filter((r) => r.confirmation_status === "confirmed" && !r.superseded).map((r) => r.fixture_id));
    const { played, remaining } = window.Fixtures.opponentSplit(team.id, fixtures, confirmedFixtureIds);
    nodes.push(
      el("details", { class: "card" }, [
        el("summary", {}, "Opponent tracker"),
        el("div", { class: "opponent-split" }, [opponentList("Played", played, teamsById, "✅"), opponentList("Still to play", remaining, teamsById, "⬜")])
      ])
    );
    return nodes;
  }

  function tableSection(standings) {
    const { league, fixtures, results, teamsById } = ctx;
    const nodes = [];
    if (league && (league.status === "completed" || league.status === "archived")) nodes.push(championCard(fixtures, results, teamsById));
    nodes.push(
      el("div", { class: "card" }, [
        el("h3", {}, "League table"),
        standingsTable(standings),
        el("p", { class: "muted small table-note" }, "Ranked by points, then set difference, then sets won.")
      ])
    );
    return nodes;
  }

  // The accepted rules, opened, plus the league's basic details.
  function rulesSection() {
    const { league, payment } = ctx;
    const info = [];
    if (league && league.start_date) info.push(["Started", formatDate(league.start_date)]);
    if (league && league.num_courts) info.push(["Courts", String(league.num_courts)]);
    if (window.EntryFee.leagueHasFee(league)) {
      info.push(["Entry fee", `${window.EntryFee.formatRand(window.EntryFee.priceFor(league.entry_fee_cents).total)} per team${payment && payment.status === "complete" ? " - paid" : ""}`]);
    }
    return [
      rulesCard(ctx.accepted, true),
      info.length
        ? el("div", { class: "card" }, [
            el("h3", {}, "League details"),
            el("dl", { class: "info-list" }, info.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]))
          ])
        : null
    ];
  }

  // The accept screen. A team link has no login, so "accepting" is typing a
  // name; one teammate accepts for the pair. The exact text shown is saved
  // alongside the name (not just a reference to the league's rules), so what
  // a team agreed to stays provable even if the rules were ever changed.
  function rulesGate(league, team) {
    const name = el("input", { class: "input", placeholder: "Type your full name", autocomplete: "name" });
    const error = el("p", { class: "form-error", hidden: true });
    const acceptBtn = el("button", { class: "btn btn-primary", type: "submit", disabled: true }, "I accept these rules");

    const form = el("form", { class: "card rules-gate" }, [
      el("div", { class: "muted small" }, league.name),
      el("h2", {}, "League rules"),
      el("p", { class: "muted" }, `Welcome, ${team.name}. Please read the rules below - you need to accept them before you can use your team page.`),
      rulesList(league.rules.items),
      el("label", { class: "field" }, [el("span", {}, "Type your full name to accept"), name]),
      el(
        "p",
        { class: "muted small" },
        "One of you can accept for both partners. By typing your name you confirm you've read these rules and agree to them on behalf of your team."
      ),
      error,
      acceptBtn
    ]);

    name.addEventListener("input", () => {
      acceptBtn.disabled = name.value.trim().length < 2;
    });

    let saving = false;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const typed = name.value.trim();
      if (saving || typed.length < 2) return;
      saving = true;
      acceptBtn.disabled = true;
      acceptBtn.textContent = "Saving...";
      error.hidden = true;
      try {
        ctx.accepted = await dbInsert("rules_acceptances", {
          league_id: league.id,
          team_id: team.id,
          accepted_name: typed,
          rules_snapshot: league.rules.items
          // created_at (stamped by dbInsert, like every table here) is the
          // time of acceptance.
        });
        render();
      } catch (err) {
        console.error(err);
        // The other teammate may have accepted from their own phone a
        // moment ago (one acceptance per team) - if so just carry on.
        try {
          const existing = (await dbList("rules_acceptances", { team_id: `eq.${team.id}` }))[0];
          if (existing) {
            ctx.accepted = existing;
            render();
            return;
          }
        } catch (err2) {
          console.error(err2);
        }
        saving = false;
        acceptBtn.disabled = false;
        acceptBtn.textContent = "I accept these rules";
        error.hidden = false;
        error.textContent = "Couldn't save - check your connection and try again.";
      }
    });

    return form;
  }

  function notOpenCard(league) {
    return el("div", { class: "card pay-gate" }, [
      el("div", { class: "muted small" }, league ? league.name : ""),
      el("h2", {}, "This league isn't open yet"),
      el("p", { class: "muted" }, "Your league organiser still needs to activate the league. Please check back soon, or contact your organiser."),
      el("button", { class: "btn btn-ghost", type: "button", onclick: () => refresh() }, "Check again")
    ]);
  }

  // ---------- Entry fee ----------

  let paymentPollTimer = null;
  let paymentPolling = false;
  let paymentPollTick = null;

  function stopPaymentPolling() {
    paymentPolling = false;
    paymentPollTick = null;
    if (paymentPollTimer) clearTimeout(paymentPollTimer);
    paymentPollTimer = null;
  }

  // Coming back to this tab (e.g. from the PayFast page) checks straight away
  // instead of waiting for the next scheduled check.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && paymentPolling && paymentPollTick) {
      if (paymentPollTimer) clearTimeout(paymentPollTimer);
      paymentPollTick();
    }
  });

  // PayFast confirms a payment by messaging our server a few seconds after
  // the team pays, so a team coming back from PayFast may briefly still show
  // as pending. Until then this asks ONE small question - "is this team's
  // payment complete yet?" - and only when the answer changes does it reload
  // the whole page. (It used to reload and redraw everything every 3 seconds,
  // six requests each time, which on a phone made the page crawl, jump back
  // to the top and sometimes pile requests up behind each other.) The next
  // check is only scheduled once the last one has finished, so they can never
  // stack up, and nothing is asked while the tab is in the background.
  function ensurePaymentPolling() {
    if (paymentPolling) return;
    paymentPolling = true;
    let checks = 0;
    const schedule = () => {
      if (!paymentPolling) return;
      paymentPollTimer = setTimeout(tick, 2500);
    };
    const tick = async () => {
      if (!paymentPolling) return;
      if (document.hidden) return schedule(); // wait until the tab is visible again
      checks += 1;
      if (checks > 80) {
        stopPaymentPolling();
        return;
      }
      try {
        const latest = latestPayment(await dbList("team_payment_status", { team_id: `eq.${ctx.team.id}` }));
        if (!paymentPolling) return;
        const was = ctx.payment ? ctx.payment.status : null;
        if ((latest ? latest.status : null) !== was) {
          stopPaymentPolling();
          await refresh();
          return;
        }
      } catch (err) {
        console.error(err);
      }
      schedule();
    };
    paymentPollTick = tick;
    schedule();
  }

  // Today's date in South Africa, to show "payment closed" without a round
  // trip. Display only - the payment function enforces the cut-off itself.
  function todayInSouthAfrica() {
    return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  // The pay screen. The price shown is the organiser's fee plus the
  // platform's 20% as one number per team; the server recomputes it from the
  // league when the team actually pays, so this is only ever a display.
  function paymentGate(league, team) {
    const price = window.EntryFee.priceFor(league.entry_fee_cents).total;
    const deadline = league.payment_deadline;
    const closed = !!deadline && todayInSouthAfrica() > deadline;
    const status = ctx.payment ? ctx.payment.status : null;
    const error = el("p", { class: "form-error", hidden: true });
    const payBtn = el("button", { class: "btn btn-primary", type: "button" }, `Pay ${window.EntryFee.formatRand(price)} with PayFast`);

    const children = [
      el("div", { class: "muted small" }, league.name),
      el("h2", {}, "Entry fee"),
      el("p", { class: "muted" }, `Welcome, ${team.name}. Your team is registered in this league once its entry fee is paid.`),
      el("div", { class: "pay-price" }, [
        el("div", { class: "pay-amount" }, window.EntryFee.formatRand(price)),
        el("div", { class: "muted small" }, "per team - covers both partners")
      ]),
      deadline ? el("p", { class: "muted" }, `Pay by ${formatDate(deadline)}.`) : null
    ];

    if (status === "refunded") {
      stopPaymentPolling();
      children.push(el("p", {}, "Your entry fee was refunded. Please contact your league organiser if you have any questions."));
      return el("div", { class: "card pay-gate" }, children);
    }

    if (closed) {
      stopPaymentPolling();
      children.push(el("p", {}, "Payment is closed - the cut-off date has passed. Please contact your league organiser."));
      return el("div", { class: "card pay-gate" }, children);
    }

    if (status === "pending") {
      children.push(
        el("p", { class: "pay-waiting" }, "Waiting for PayFast to confirm your payment. If you've just paid, this page updates by itself in a few seconds."),
        el("p", { class: "muted small" }, "Didn't finish paying? You can start again below.")
      );
      ensurePaymentPolling();
    } else {
      stopPaymentPolling();
    }

    children.push(
      error,
      payBtn,
      el("p", { class: "muted small" }, "You'll be taken to PayFast's secure payment page (card or instant EFT) and brought back here afterwards.")
    );

    payBtn.addEventListener("click", async () => {
      payBtn.disabled = true;
      payBtn.textContent = "Starting payment...";
      error.hidden = true;
      try {
        const res = await fetch(`${window.LEAGUE_CONFIG.supabaseUrl}/functions/v1/payfast/team-pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: window.LEAGUE_CONFIG.supabaseAnonKey },
          body: JSON.stringify({ code: team.access_code })
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          postForm(body.action, body.fields);
          return;
        }
        if (body.paid) {
          await refresh(); // already paid (e.g. from the other teammate's phone)
          return;
        }
        throw new Error(body.error || `HTTP ${res.status}`);
      } catch (err) {
        console.error(err);
        payBtn.disabled = false;
        payBtn.textContent = `Pay ${window.EntryFee.formatRand(price)} with PayFast`;
        error.hidden = false;
        error.textContent = err && err.message && err.message !== "Failed to fetch" ? err.message : "Couldn't start the payment - check your connection and try again.";
      }
    });

    return el("div", { class: "card pay-gate" }, children);
  }

  // The rules the team accepted, for re-reading any time - collapsed by
  // default at the bottom of the dashboard so it doesn't get in the way.
  function rulesCard(accepted, open) {
    return el("details", { class: "card rules-card", open: open ? "" : undefined }, [
      el("summary", {}, "League rules"),
      el("p", { class: "muted small" }, `Accepted by ${accepted.accepted_name} on ${formatDate(accepted.created_at.slice(0, 10))}`),
      rulesList(accepted.rules_snapshot)
    ]);
  }

  function championCard(fixtures, results, teamsById) {
    const final = fixtures.find((f) => f.stage === "F");
    const result = final ? window.Results.activeResultForFixture(final.id, results) : null;
    if (!final || !result || result.confirmation_status !== "confirmed") return null;
    const sw = window.Standings.setsWon(result);
    const championId = sw.team1 >= 2 ? final.team1_id : final.team2_id;
    const champion = teamsById[championId];
    if (!champion) return null;
    return el("div", { class: "card champion-card" }, [
      el("div", {}, "🏆 LEAGUE CHAMPIONS"),
      el("h2", {}, champion.name),
      el("p", { class: "muted" }, `${champion.player1} + ${champion.player2}`)
    ]);
  }

  function statTile(label, value) {
    return el("div", { class: "stat-tile" }, [el("div", { class: "stat-value" }, String(value)), el("div", { class: "stat-label" }, label)]);
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function standingsTable(rows) {
    const headerRow = el("div", { class: "standings-row standings-header" }, [
      el("span", {}, "Pos"),
      el("span", { class: "standings-team" }, "Team"),
      el("span", {}, "P"),
      el("span", {}, "W"),
      el("span", {}, "L"),
      el("span", {}, "SW"),
      el("span", {}, "SL"),
      el("span", {}, "PTS")
    ]);
    const rowEls = rows.map((r) =>
      el("div", { class: `standings-row${r.team.id === ctx.team.id ? " standings-me" : ""}` }, [
        el("span", {}, String(r.position)),
        el("span", { class: "standings-team" }, r.team.name),
        el("span", {}, String(r.played)),
        el("span", {}, String(r.won)),
        el("span", {}, String(r.lost)),
        el("span", {}, String(r.setsWon)),
        el("span", {}, String(r.setsLost)),
        el("span", { class: "standings-pts" }, String(r.pts))
      ])
    );
    return el("div", { class: "standings-table" }, [headerRow, ...rowEls]);
  }

  const STAGE_LABEL = { QF: "Quarter-final", SF: "Semi-final", F: "Final" };

  function fixtureRow(f) {
    const { team, teamsById, results } = ctx;
    const label = f.stage === "league" ? `Week ${f.week}` : STAGE_LABEL[f.stage] || f.stage;

    if (f.status === "bye") {
      return el("div", { class: "fixture-row muted" }, [el("span", { class: "court-tag" }, label), el("span", {}, "Bye week")]);
    }
    if (f.team1_id == null || f.team2_id == null) {
      return el("div", { class: "fixture-row muted" }, [el("span", { class: "court-tag" }, label), el("span", {}, "Waiting on earlier round")]);
    }

    const oppId = f.team1_id === team.id ? f.team2_id : f.team1_id;
    const oppTeam = teamsById[oppId];
    const result = window.Results.activeResultForFixture(f.id, results);
    const isTeam1 = f.team1_id === team.id;

    const base = [el("span", { class: "court-tag" }, label), opponentBlock(oppTeam, "vs ")];

    if (!result) {
      // Submit result is the primary action on an unplayed fixture (filled
      // teal, matching .btn-primary elsewhere), View availability is
      // secondary/informational (outlined) - grouped together in one tidy
      // actions row instead of one sitting inline in the header row and the
      // other floating below it, so the two are never mistaken for the same
      // kind of action.
      const open = openSubmitForms.has(f.id);
      const submitBtn = el(
        "button",
        { class: `btn small ${open ? "btn-ghost" : "btn-primary"}`, type: "button", onclick: () => toggleSubmitForm(f.id) },
        open ? "Cancel" : "✏️ Submit result"
      );
      const availSummary = opponentAvailabilitySummary(oppTeam, f.id);
      return el("div", { class: "fixture-block" }, [
        el("div", { class: "fixture-row" }, base),
        el("div", { class: "fixture-actions" }, availSummary ? [submitBtn, availSummary] : [submitBtn]),
        open ? submitForm(f, isTeam1, oppTeam) : null
      ]);
    }

    const sw = window.Standings.setsWon(result);
    const myWon = isTeam1 ? sw.team1 : sw.team2;
    const oppWon = isTeam1 ? sw.team2 : sw.team1;
    const scoreText = `${myWon}-${oppWon}`;
    const setDetail = el("p", { class: "muted small" }, `Sets: ${window.Render.formatSets(result, !isTeam1)}`);

    if (result.confirmation_status === "confirmed") {
      return el("div", { class: "fixture-block" }, [el("div", { class: "fixture-row" }, [...base, window.Render.badge(`${scoreText} confirmed`, "green")]), setDetail]);
    }

    if (result.confirmation_status === "disputed") {
      return el("div", { class: "fixture-block" }, [el("div", { class: "fixture-row" }, [...base, window.Render.badge(`${scoreText} disputed`, "amber")]), setDetail]);
    }

    // pending
    const iSubmitted = result.submitted_by_team_id === team.id;
    if (iSubmitted) {
      return el("div", { class: "fixture-block" }, [el("div", { class: "fixture-row" }, [...base, window.Render.badge(`${scoreText} awaiting confirmation`, "blue")]), setDetail]);
    }

    const disputeReason = el("input", { class: "input", placeholder: "Optional reason for admin" });
    return el("div", { class: "fixture-block" }, [
      el("div", { class: "fixture-row" }, [...base, el("strong", {}, scoreText)]),
      setDetail,
      el("div", { class: "row-actions" }, [
        el("button", { class: "btn btn-primary small", type: "button", onclick: () => doConfirm(result) }, "Confirm result"),
        el("button", { class: "btn btn-danger small", type: "button", onclick: () => doDispute(result, disputeReason.value) }, "Dispute result")
      ]),
      disputeReason
    ]);
  }

  // Compact 2-row x 3-column score grid (team down the side, S1/S2/S3 across
  // the top) instead of 6 full-width stacked fields - the whole 3-set score
  // is visible without scrolling, even at 320px. See .score-grid in
  // style.css.
  function submitForm(fixture, isTeam1, oppTeam) {
    const myInputs = [1, 2, 3].map(() => scoreInput());
    const oppInputs = [1, 2, 3].map(() => scoreInput());
    // Focus order is interleaved (your S1, their S1, your S2, ...) rather
    // than the grid's row-major DOM order (your 3 sets, then theirs) -
    // matches how a set is actually scored: both teams' numbers for one set
    // before moving to the next set.
    wireAutoAdvance([myInputs[0], oppInputs[0], myInputs[1], oppInputs[1], myInputs[2], oppInputs[2]]);
    const error = el("p", { class: "form-error", hidden: true });

    const grid = scoreGrid(opponentBlock(ctx.team, ""), myInputs, opponentBlock(oppTeam, ""), oppInputs);

    const submitBtn = el("button", { class: "btn btn-primary small", type: "submit" }, "Submit result");
    const form = el("form", { class: "card inline-form" }, [grid, error, submitBtn]);
    let isSubmitting = false;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (isSubmitting) return; // guards a double-tap/double-fire of the submit event itself
      const mySets = myInputs.map((i) => i.value);
      const oppSets = oppInputs.map((i) => i.value);
      if (mySets.some((v) => v === "") || oppSets.some((v) => v === "")) {
        error.hidden = false;
        error.textContent = "Enter all 3 sets.";
        return;
      }
      const my = mySets.map(Number);
      const opp = oppSets.map(Number);
      if (my.some((v, i) => v === opp[i])) {
        error.hidden = false;
        error.textContent = "A set can't be tied - one team must win each set.";
        return;
      }
      const confirmed = await confirmSubmitModal();
      if (!confirmed) return; // back to the form - scores already entered are untouched

      // The round trip to actually save takes a second or two - disable the
      // button for that whole window (not just while the modal is open) so
      // an impatient second tap can never insert a duplicate result, and so
      // it's never ambiguous whether the first tap "took".
      isSubmitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting...";
      error.hidden = true;
      try {
        await window.Results.submitResult(fixture, ctx.team.id, my, opp);
        openSubmitForms.delete(fixture.id);
        await refresh();
      } catch (err) {
        console.error(err);
        isSubmitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit result";
        error.hidden = false;
        error.textContent = "Couldn't submit - check your connection and try again. Your scores are still here.";
      }
    });

    return form;
  }

  // Reminder modal shown before a result actually submits - appended
  // straight to <body> (not re-rendered through render()), so opening/
  // closing it never touches the score form underneath and nothing entered
  // is ever lost. Resolves true only if the player taps "Submit result";
  // Escape, clicking outside, or "Go back" all resolve false.
  function confirmSubmitModal() {
    return new Promise((resolve) => {
      const goBack = el("button", { class: "btn btn-ghost small", type: "button" }, "Go back");
      const confirmBtn = el("button", { class: "btn btn-primary small", type: "button" }, "Submit result");
      const card = el("div", { class: "card modal-card" }, [
        el("h3", {}, "Confirm match result"),
        el("p", {}, "Before submitting, please remember:"),
        el("ul", { class: "modal-list" }, [
          el("li", {}, "Update the match score on Playtomic as well."),
          el("li", {}, "Make sure the opposing team confirms the result in this app.")
        ]),
        el("p", { class: "muted small" }, "Only submit the result once you are happy that the scores entered are correct."),
        el("div", { class: "row-actions modal-actions" }, [goBack, confirmBtn])
      ]);
      const backdrop = el("div", { class: "modal-backdrop" }, [card]);

      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";

      function close(result) {
        document.removeEventListener("keydown", onKeydown);
        document.body.style.overflow = prevOverflow;
        backdrop.remove();
        resolve(result);
      }
      function onKeydown(e) {
        if (e.key === "Escape") close(false);
      }
      goBack.addEventListener("click", () => close(false));
      confirmBtn.addEventListener("click", () => close(true));
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close(false);
      });
      document.addEventListener("keydown", onKeydown);

      document.body.appendChild(backdrop);
    });
  }

  function field(label, input) {
    return el("label", { class: "field" }, [el("span", {}, label), input]);
  }

  function toggleSubmitForm(fixtureId) {
    if (openSubmitForms.has(fixtureId)) openSubmitForms.delete(fixtureId);
    else openSubmitForms.add(fixtureId);
    render();
  }

  async function doConfirm(result) {
    await window.Results.confirmResult(result, ctx.team.id);
    await refresh();
  }

  async function doDispute(result, reason) {
    await window.Results.disputeResult(result, reason);
    await refresh();
  }

  // Team name stays prominent; both players from that team's existing
  // record show underneath in smaller text - always read live from
  // teamsById, never duplicated/stored separately, so a rename in the
  // league is reflected here automatically.
  function opponentBlock(team, prefix) {
    if (!team) return el("span", {}, `${prefix || ""}Unknown`);
    return el("div", { class: "opponent-block" }, [
      el("div", { class: "opponent-block-name" }, `${prefix || ""}${team.name}`),
      el("div", { class: "opponent-block-players" }, `${team.player1} & ${team.player2}`)
    ]);
  }

  function opponentList(title, entries, teamsById, icon) {
    return el("div", {}, [
      el("div", { class: "opponent-list-title" }, title),
      entries.length
        ? el(
            "ul",
            { class: "opponent-list" },
            entries.map((e) => el("li", {}, [el("span", { class: "opponent-list-icon" }, icon), opponentBlock(teamsById[e.opponentId])]))
          )
        : el("p", { class: "muted small" }, "None")
    ]);
  }

  // ---------- Team availability ----------
  // Optional board so two opposing teams can tell each other when they can
  // play, scoped to the current real-world week (never a stale week) and
  // gated entirely by league.availability_enabled - when off, both this card
  // and opponentAvailabilitySummary() below render nothing, but nothing is
  // deleted so turning it back on immediately shows whatever was saved.

  function availabilityCard() {
    const { league, team, availability } = ctx;
    if (league && league.availability_enabled === false) return null;

    const weekStart = window.Availability.currentWeekStartISO();
    const mine = window.Availability.forTeamWeek(team.id, weekStart, availability);

    if (!availabilityEditing) {
      return el("div", { class: "card" }, [
        el("h3", {}, "Team availability"),
        el("p", { class: "muted small" }, `For ${window.Availability.formatWeekRange(weekStart)}`),
        mine && mine.slots && mine.slots.length
          ? el(
              "div",
              { class: "avail-chips" },
              mine.slots.map((s) => el("span", { class: "avail-chip" }, `${window.Availability.slotDayLabel(s)} ${s.start}-${s.end}`))
            )
          : el("p", { class: "empty-state" }, "You haven't shared your availability for this week yet."),
        mine && mine.note ? el("p", { class: "muted small avail-note" }, `Note: ${mine.note}`) : null,
        el(
          "button",
          { class: "btn btn-ghost small", type: "button", onclick: () => { availabilityEditing = true; render(); } },
          mine ? "Update my availability" : "+ Add my availability"
        ),
        // Said once here rather than repeated under every fixture's "View
        // <opponent>'s availability" button, which would clutter the list -
        // this is the one place a player is actively thinking about
        // availability, so it's the natural spot to explain both halves.
        el("p", { class: "muted small avail-hint" }, "This is your own team's availability. You can see when your opponents are available to play from each upcoming fixture below.")
      ]);
    }

    return el("div", { class: "card" }, [
      el("h3", {}, "Team availability"),
      el("p", { class: "muted small" }, `For ${window.Availability.formatWeekRange(weekStart)}`),
      availabilityEditForm(weekStart, mine)
    ]);
  }

  function availabilityEditForm(weekStart, existing) {
    const initialSlots = existing && existing.slots && existing.slots.length ? existing.slots : [null];
    const rowsContainer = el("div", { class: "stack avail-rows" }, initialSlots.map((s) => availSlotRow(s)));
    const addBtn = el(
      "button",
      { class: "btn btn-ghost small", type: "button", onclick: () => rowsContainer.appendChild(availSlotRow(null)) },
      "+ Add time slot"
    );
    const note = el("input", {
      class: "input",
      placeholder: "e.g. Tuesday evening preferred",
      value: (existing && existing.note) || ""
    });
    const error = el("p", { class: "form-error", hidden: true });

    const saveBtn = el("button", { class: "btn btn-primary small", type: "submit" }, "Save availability");
    const cancelBtn = el("button", { class: "btn btn-ghost small", type: "button", onclick: () => { availabilityEditing = false; render(); } }, "Cancel");
    const form = el("form", { class: "stack inline-form" }, [
      rowsContainer,
      addBtn,
      field("Note (optional)", note),
      error,
      el("div", { class: "row-actions" }, [saveBtn, cancelBtn])
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const slots = [];
      for (const row of Array.from(rowsContainer.children)) {
        const isRange = row.dataset.availType === "range";
        const day = row.querySelector(isRange ? '[data-role="from-day"]' : '[data-role="day"]').value;
        const toDay = isRange ? row.querySelector('[data-role="to-day"]').value : null;
        const startH = row.querySelector('[data-role="start-h"]').value;
        const endH = row.querySelector('[data-role="end-h"]').value;
        const start = startH ? `${startH}:${row.querySelector('[data-role="start-m"]').value}` : "";
        const end = endH ? `${endH}:${row.querySelector('[data-role="end-m"]').value}` : "";
        if (!start && !end) continue; // untouched blank row
        if (!start || !end) {
          error.hidden = false;
          error.textContent = "Each time slot needs both a start and end time.";
          return;
        }
        if (start >= end) {
          error.hidden = false;
          error.textContent = "End time must be after start time.";
          return;
        }
        if (isRange && window.Availability.DAYS.indexOf(toDay) < window.Availability.DAYS.indexOf(day)) {
          error.hidden = false;
          error.textContent = '"To day" must be on or after "From day".';
          return;
        }
        slots.push(isRange ? { day, toDay, start, end } : { day, start, end });
      }

      // No feedback while the save round-trips to Supabase used to make the
      // button look unresponsive/broken on a slower connection - disable it
      // and say so instead, and surface a real error if the request fails
      // rather than leaving the button looking stuck forever.
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      try {
        await window.Availability.saveAvailability({
          existingId: existing ? existing.id : null,
          teamId: ctx.team.id,
          leagueId: ctx.league.id,
          weekStart,
          slots,
          note: note.value.trim() || null
        });
        availabilityEditing = false;
        await refresh();
      } catch (err) {
        console.error(err);
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = "Save availability";
        error.hidden = false;
        error.textContent = "Couldn't save - check your connection and try again.";
      }
    });

    return form;
  }

  // Built with plain DOM appendChild/remove (not through render()) so adding
  // or removing a slot never wipes whatever the team has already typed into
  // the other rows, and never jumps the page - see the mobile "don't reset
  // the form" requirement this feature was built under.
  //
  // Each entry can be a single day OR a day range (Mon-Fri) - both day
  // pickers are always in the DOM (so switching type never loses either
  // selection), just shown/hidden via row.dataset.availType, which the
  // submit handler in availabilityEditForm reads to know which one to save.
  function availSlotRow(slot) {
    const isRange = !!(slot && slot.toDay && slot.toDay !== slot.day);
    const row = el("div", { class: "avail-entry" });

    const day = el(
      "select",
      { class: "input", "data-role": "day" },
      window.Availability.DAYS.map((d) => el("option", { value: d }, window.Availability.DAY_LABELS[d]))
    );
    day.value = (slot && slot.day) || "Mon";
    const dayBlock = el("div", { class: "avail-day-row" }, [field("Day", day)]);

    const fromDay = el(
      "select",
      { class: "input", "data-role": "from-day" },
      window.Availability.DAYS.map((d) => el("option", { value: d }, window.Availability.DAY_LABELS[d]))
    );
    fromDay.value = (slot && slot.day) || "Mon";
    const toDay = el(
      "select",
      { class: "input", "data-role": "to-day" },
      window.Availability.DAYS.map((d) => el("option", { value: d }, window.Availability.DAY_LABELS[d]))
    );
    toDay.value = (slot && slot.toDay) || "Fri";
    const rangeBlock = el("div", { class: "avail-day-row" }, [field("From day", fromDay), field("To day", toDay)]);

    const indivBtn = el("button", { class: "btn small avail-type-btn", type: "button" }, "Individual day");
    const rangeBtn = el("button", { class: "btn small avail-type-btn", type: "button" }, "Day range");

    function setType(type) {
      // Toggle inline style rather than the `hidden` attribute - .avail-day-row's
      // own display:flex rule has equal specificity to the UA [hidden]
      // stylesheet rule and, being an author style, wins the tie, so
      // `.hidden = true` alone doesn't actually hide it.
      row.dataset.availType = type;
      dayBlock.style.display = type === "individual" ? "flex" : "none";
      rangeBlock.style.display = type === "range" ? "flex" : "none";
      indivBtn.classList.toggle("active", type === "individual");
      rangeBtn.classList.toggle("active", type === "range");
    }
    indivBtn.addEventListener("click", () => setType("individual"));
    rangeBtn.addEventListener("click", () => setType("range"));

    const start = timeUnit("start", slot && slot.start);
    const end = timeUnit("end", slot && slot.end);
    const timeRow = el("div", { class: "avail-row" }, [start, end]);
    const remove = el("button", { class: "btn btn-ghost small", type: "button", onclick: () => row.remove() }, "Remove");
    timeRow.appendChild(remove);

    row.appendChild(el("div", { class: "avail-type-toggle" }, [indivBtn, rangeBtn]));
    row.appendChild(dayBlock);
    row.appendChild(rangeBlock);
    row.appendChild(timeRow);
    setType(isRange ? "range" : "individual");
    return row;
  }

  // Plain hour/minute <select> pair instead of <input type="time"> - a
  // native time input's displayed format (12h AM/PM vs 24h) follows the
  // device's OS locale and can't be forced to 24h from the page (the usual
  // lang="en-GB" trick no longer works in current Chrome/Safari), so this is
  // the only way to guarantee every team always sees 24h, regardless of
  // their phone's locale settings.
  function timeUnit(prefix, value) {
    const [h, m] = (value || "").split(":");
    const hour = el(
      "select",
      { class: "avail-time-h", "data-role": `${prefix}-h` },
      [el("option", { value: "" }, "--"), ...Array.from({ length: 24 }, (_, i) => el("option", { value: pad2(i) }, pad2(i)))]
    );
    hour.value = h || "";
    const minute = el(
      "select",
      { class: "avail-time-m", "data-role": `${prefix}-m` },
      ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"].map((mm) => el("option", { value: mm }, mm))
    );
    minute.value = m || "00";
    return el("div", { class: "avail-time" }, [hour, el("span", { class: "avail-time-sep" }, ":"), minute]);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // Compact "View <opponent>'s availability" toggle for an opponent's
  // CURRENT-week slots only - an opponent can view but never edit. The
  // team name is spelled out (never just "View availability") so a player
  // who just finished updating their OWN availability doesn't click this
  // expecting to see it played back to them - that mix-up is exactly what
  // this wording exists to prevent. Returns null (renders nothing) if the
  // feature is off, there's no opponent yet, or that opponent hasn't
  // shared anything for the current week, so it never enlarges a fixture
  // card with an empty section.
  function opponentAvailabilitySummary(oppTeam, key) {
    const { league, availability } = ctx;
    if (!oppTeam || (league && league.availability_enabled === false)) return null;

    const weekStart = window.Availability.currentWeekStartISO();
    const theirs = window.Availability.forTeamWeek(oppTeam.id, weekStart, availability);
    if (!theirs || !theirs.slots || !theirs.slots.length) return null;

    const expanded = expandedAvail.has(key);
    const toggle = el(
      "button",
      {
        class: "btn btn-ghost small avail-toggle",
        type: "button",
        onclick: () => {
          if (expanded) expandedAvail.delete(key);
          else expandedAvail.add(key);
          render();
        }
      },
      expanded ? `Hide ${oppTeam.name}'s availability` : `🗓️ View ${oppTeam.name}'s availability`
    );
    if (!expanded) return el("div", { class: "avail-summary" }, [toggle]);

    return el("div", { class: "avail-summary" }, [
      toggle,
      el(
        "div",
        { class: "avail-chips" },
        theirs.slots.map((s) => el("span", { class: "avail-chip" }, `${window.Availability.slotDayLabel(s)} ${s.start}-${s.end}`))
      ),
      theirs.note ? el("p", { class: "muted small avail-note" }, `Note: ${theirs.note}`) : null
    ]);
  }
})();
