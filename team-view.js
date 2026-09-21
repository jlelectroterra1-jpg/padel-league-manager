// Team dashboard: resolves ?code=... (or a remembered code) to a team, then
// shows that team's fixtures with score submission / confirmation / dispute.
// Write-path logic lives in results.js - this file is DOM glue only.
(function () {
  const { el, qs } = window.Render;
  const { dbList } = window.DB;

  const app = document.getElementById("app");
  const openSubmitForms = new Set();
  const expandedAvail = new Set();
  let availabilityEditing = false;
  let ctx = null; // { team, league, teamsById, fixtures, results, availability }

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
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
    await loadLeagueData(team);
  }

  // Re-fetches everything about the current league/team without re-resolving
  // the team from its access code - call this (not loadAndRender) after any
  // in-app action (submit/confirm/dispute/availability save).
  async function refresh() {
    await loadLeagueData(ctx.team);
  }

  async function loadLeagueData(team) {
    const [league, allTeams, fixtures, results, availability] = await Promise.all([
      dbList("leagues", { id: `eq.${team.league_id}` }).then((r) => r[0]),
      dbList("teams", { league_id: `eq.${team.league_id}` }),
      dbList("fixtures", { league_id: `eq.${team.league_id}` }),
      // Scoped to this league's fixtures via Supabase's join-filter syntax,
      // instead of fetching every league's results and filtering client
      // side - the old dbList("results") pulled the whole table on every
      // load, growing forever as any league (not just this one) plays more
      // matches.
      dbList("results", { select: "*,fixtures!inner(id)", "fixtures.league_id": `eq.${team.league_id}` }),
      dbList("availability", { league_id: `eq.${team.league_id}` })
    ]);
    const teamsById = Object.fromEntries(allTeams.map((t) => [t.id, t]));
    // Re-resolve from the just-fetched teams list (by id) rather than
    // trusting the possibly-stale `team` passed in - keeps e.g. a name
    // change made elsewhere in the league picked up on every refresh.
    const freshTeam = teamsById[team.id] || team;

    ctx = { team: freshTeam, league, teamsById, fixtures, results, availability };
    render();
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

    const standings = window.Standings.computeStandings(allTeams, fixtures, results);
    const myRow = standings.find((r) => r.team.id === team.id);
    const next = window.Fixtures.nextFixtureForTeam(team.id, fixtures, results);
    const nextOpp = next ? (next.team1_id === team.id ? next.team2_id : next.team1_id) : null;

    if (league && (league.status === "completed" || league.status === "archived")) {
      const champion = championCard(fixtures, results, teamsById);
      if (champion) app.appendChild(champion);
    }

    // Visual hierarchy, strongest to weakest: MY team name > my players >
    // stats > next match/opponent name > opponent players. The page must
    // read as "this is MY dashboard" before anything else, so the viewer's
    // own team gets the strongest identity treatment and the opponent
    // (inside the next-match callout) is deliberately smaller/lighter -
    // never allowed to outweigh the team name above it.
    app.appendChild(
      el("div", { class: "card team-hero" }, [
        el("div", { class: "muted small" }, league ? league.name : ""),
        el("div", { class: "my-team-label" }, "Your team"),
        el("h2", {}, team.name),
        el("p", { class: "muted" }, `${team.player1} + ${team.player2}`),
        myRow
          ? el("div", { class: "summary-grid" }, [
              statTile("Position", ordinal(myRow.position)),
              statTile("Played", myRow.played),
              statTile("Won", myRow.won),
              statTile("Lost", myRow.lost),
              statTile("Points", myRow.pts)
            ])
          : null,
        next
          ? el("div", { class: "next-match" }, [
              el("div", { class: "label" }, `Your next match · Week ${next.week}`),
              el("div", { class: "opp-label" }, "Opponent"),
              el("div", { class: "opp" }, teamsById[nextOpp] ? teamsById[nextOpp].name : "Unknown"),
              teamsById[nextOpp] ? el("div", { class: "opp-players" }, `${teamsById[nextOpp].player1} & ${teamsById[nextOpp].player2}`) : null,
              opponentAvailabilitySummary(teamsById[nextOpp], "next")
            ])
          : null
      ])
    );

    const availCard = availabilityCard();
    if (availCard) app.appendChild(availCard);

    const confirmedFixtureIds = new Set(
      results.filter((r) => r.confirmation_status === "confirmed" && !r.superseded).map((r) => r.fixture_id)
    );
    const myFixtures = fixtures.filter((f) => f.stage === "league" && (f.team1_id === team.id || f.team2_id === team.id));
    const myPlayoffFixtures = fixtures.filter((f) => f.stage !== "league" && (f.team1_id === team.id || f.team2_id === team.id));

    app.appendChild(
      el("div", { class: "card" }, [
        el("h3", {}, "My fixtures"),
        myFixtures.length
          ? el("div", { class: "stack" }, myFixtures.sort((a, b) => a.week - b.week).map((f) => fixtureRow(f)))
          : el("p", { class: "empty-state" }, "Fixtures haven't been generated yet - check back once your admin sets the schedule.")
      ])
    );

    if (myPlayoffFixtures.length) {
      const stageOrder = { QF: 0, SF: 1, F: 2 };
      app.appendChild(
        el("div", { class: "card" }, [
          el("h3", {}, "My playoff matches"),
          el("div", { class: "stack" }, myPlayoffFixtures.sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage]).map((f) => fixtureRow(f)))
        ])
      );
    }

    const { played, remaining } = window.Fixtures.opponentSplit(team.id, fixtures, confirmedFixtureIds);
    app.appendChild(
      el("div", { class: "card" }, [
        el("h3", {}, "Opponent tracker"),
        el("div", { class: "opponent-split" }, [
          opponentList("Played", played, teamsById, "✅"),
          opponentList("Still to play", remaining, teamsById, "⬜")
        ])
      ])
    );

    app.appendChild(el("div", { class: "card" }, [el("h3", {}, "League table"), standingsTable(standings)]));

    window.scrollTo(0, scrollY);
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
    wireEnterAdvance([...myInputs, ...oppInputs]);
    const error = el("p", { class: "form-error", hidden: true });

    const grid = el("div", { class: "score-grid" }, [
      el("div", { class: "score-grid-label" }),
      el("div", { class: "score-grid-head" }, "S1"),
      el("div", { class: "score-grid-head" }, "S2"),
      el("div", { class: "score-grid-head" }, "S3"),
      el("div", { class: "score-grid-team" }, opponentBlock(ctx.team, "")),
      ...myInputs,
      el("div", { class: "score-grid-team" }, opponentBlock(oppTeam, "")),
      ...oppInputs
    ]);

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

  function scoreInput() {
    return el("input", { class: "input score-input", type: "number", min: "0", inputmode: "numeric" });
  }

  // Enter/"Next" on a mobile numeric keypad moves to the next box instead of
  // trying to submit the form early; the last box's key is left as "Done".
  function wireEnterAdvance(inputs) {
    inputs.forEach((input, i) => {
      input.setAttribute("enterkeyhint", i < inputs.length - 1 ? "next" : "done");
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const next = inputs[i + 1];
        if (next) next.focus();
        else input.blur();
      });
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
