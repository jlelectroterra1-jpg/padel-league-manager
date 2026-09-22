// Admin console: league + team CRUD, fixture generation, fixture/opponent views.
// DOM glue only - all scheduling math lives in fixtures.js.
(function () {
  const { el, formatDate, badge, genAccessCode, scoreGrid, scoreInput, wireAutoAdvance } = window.Render;
  const { dbList, dbGet, dbInsert, dbUpdate, dbDelete } = window.DB;

  const app = document.getElementById("app");
  const expandedTeams = new Set();
  const editingTeams = new Set();

  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (parts[0] === "league" && parts[1]) {
      return { view: "league", leagueId: parts[1], tab: parts[2] || "teams" };
    }
    return { view: "leagues" };
  }

  function navigate(hash) {
    location.hash = hash;
  }

  // Navigating to a different tab/league is a real page change, so it resets
  // scroll to the top like normal navigation would. An in-place re-render
  // triggered by an action on the CURRENT view (toggling a section, saving a
  // form, confirming a result) should not - render() always restores
  // whatever scroll position was current when it was called, so a plain
  // direct call from a toggle/submit handler naturally keeps the user where
  // they were instead of the page jumping to the top.
  window.addEventListener("hashchange", () => {
    window.scrollTo(0, 0);
    render();
  });
  document.addEventListener("DOMContentLoaded", render);

  async function render() {
    const scrollY = window.scrollY;
    const route = parseHash();
    // Only show a loading placeholder on the very first render (#app is
    // still empty). Every later call to render() - triggered by clicking a
    // tab, expanding a row, saving a score, confirming a result, anything -
    // used to ALWAYS wipe #app and show "Loading..." here first, then wipe
    // and rebuild it again once renderLeaguesView()/renderLeagueDetail()
    // got fresh data. That's what made every action, including saving a
    // score, visibly flash to a blank loading screen and back: two wipes
    // instead of one, with a "Loading..." flash in between. Both of those
    // functions already do their own atomic wipe-and-rebuild once data is
    // ready, so once #app has real content, this outer wipe is redundant -
    // skip it and leave the current view on screen until the fresh one is
    // ready to replace it in one step.
    if (!app.hasChildNodes()) {
      app.appendChild(el("p", { class: "loading" }, "Loading..."));
    }
    try {
      if (route.view === "leagues") {
        await renderLeaguesView();
      } else {
        await renderLeagueDetail(route.leagueId, route.tab);
      }
    } catch (err) {
      console.error(err);
      app.innerHTML = "";
      app.appendChild(el("div", { class: "card" }, [
        el("h3", {}, "Something went wrong"),
        el("p", { class: "muted" }, String(err.message || err))
      ]));
    }
    window.scrollTo(0, scrollY);
  }

  // ---------- Leagues list ----------

  async function renderLeaguesView() {
    const leagues = await dbList("leagues");
    app.innerHTML = "";

    const list = el(
      "div",
      { class: "stack" },
      leagues.length
        ? leagues.map(leagueCard)
        : el("p", { class: "empty-state" }, "No leagues yet - create your first one below.")
    );

    app.appendChild(el("div", { class: "card" }, [el("h2", {}, "Your leagues"), list]));
    app.appendChild(newLeagueForm());
  }

  function leagueCard(league) {
    return el("a", { class: "league-row", href: `#/league/${league.id}/teams` }, [
      el("div", {}, [
        el("div", { class: "league-row-name" }, league.name),
        el("div", { class: "muted small" }, [
          league.num_teams ? `${league.num_teams} teams target` : "",
          league.start_date ? ` · starts ${formatDate(league.start_date)}` : ""
        ].join(""))
      ]),
      badge(league.status, statusKind(league.status))
    ]);
  }

  function statusKind(status) {
    return { draft: "neutral", active: "blue", playoffs: "amber", completed: "green", archived: "neutral" }[status] || "neutral";
  }

  function newLeagueForm() {
    const name = el("input", { class: "input", placeholder: "e.g. Friday Night Padel League" });
    const description = el("input", { class: "input", placeholder: "Optional description" });
    const startDate = el("input", { class: "input", type: "date" });
    const numTeams = el("input", { class: "input", type: "number", min: "6", value: "10" });
    const numCourts = el("input", { class: "input", type: "number", min: "1", value: "2" });
    const playoffSize = el("select", { class: "input" }, [
      el("option", { value: "8" }, "Top 8 (quarter-finals)"),
      el("option", { value: "4" }, "Top 4 (semi-finals)"),
      el("option", { value: "2" }, "Top 2 (final only)")
    ]);
    const error = el("p", { class: "form-error", hidden: true });

    const form = el("form", { class: "card" }, [
      el("h2", {}, "Create a new league"),
      field("League name", name),
      field("Description", description),
      el("div", { class: "field-row" }, [field("Start date", startDate), field("Number of teams", numTeams)]),
      el("div", { class: "field-row" }, [field("Number of courts", numCourts), field("Playoff format", playoffSize)]),
      el("p", { class: "muted small" }, "Every match is 3 sets - each set won is worth 1 league point."),
      error,
      el("button", { class: "btn btn-primary", type: "submit" }, "Create league")
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!name.value.trim()) {
        error.hidden = false;
        error.textContent = "League name is required.";
        return;
      }
      const league = await dbInsert("leagues", {
        name: name.value.trim(),
        description: description.value.trim() || null,
        start_date: startDate.value || null,
        num_teams: Number(numTeams.value) || null,
        num_courts: Number(numCourts.value) || 1,
        playoff_size: Number(playoffSize.value),
        status: "draft"
      });
      navigate(`#/league/${league.id}/teams`);
    });

    return form;
  }

  function field(label, input) {
    return el("label", { class: "field" }, [el("span", {}, label), input]);
  }

  // ---------- League detail ----------

  async function renderLeagueDetail(leagueId, tab) {
    const [league, teams, fixtures, results] = await Promise.all([
      dbGet("leagues", leagueId),
      dbList("teams", { league_id: `eq.${leagueId}` }),
      dbList("fixtures", { league_id: `eq.${leagueId}` }),
      // Scoped to this league via Supabase's join-filter syntax, instead of
      // fetching every league's results and filtering client side - this
      // ran on every tab switch/action in admin, including ones that don't
      // even touch results (e.g. expanding a team row), so an unscoped
      // fetch here was wasted on nearly every click.
      dbList("results", { select: "*,fixtures!inner(id)", "fixtures.league_id": `eq.${leagueId}` })
    ]);

    app.innerHTML = "";
    if (!league) {
      app.appendChild(el("div", { class: "card" }, "League not found."));
      return;
    }

    const pendingCount = results.filter((r) => r.confirmation_status === "pending" && !r.superseded).length;
    const disputedCount = results.filter((r) => r.confirmation_status === "disputed" && !r.superseded).length;

    app.appendChild(
      el("div", { class: "detail-header" }, [
        el("a", { class: "back-link", href: "#/leagues" }, "← All leagues"),
        el("h2", {}, league.name),
        badge(league.status, statusKind(league.status))
      ])
    );

    app.appendChild(leagueStatsStrip(teams, fixtures, results));

    const tabLabels = {
      teams: "Teams",
      fixtures: "Fixtures",
      standings: "Standings",
      confirmations: `Confirmations${pendingCount ? ` (${pendingCount})` : ""}`,
      disputes: `Disputes${disputedCount ? ` (${disputedCount})` : ""}`,
      playoffs: "Playoffs",
      settings: "Settings"
    };

    app.appendChild(
      el(
        "div",
        { class: "tabs-inline" },
        Object.keys(tabLabels).map((t) =>
          el("a", { class: `tab-inline ${t === tab ? "active" : ""}`, href: `#/league/${leagueId}/${t}` }, tabLabels[t])
        )
      )
    );

    if (tab === "teams") app.appendChild(renderTeamsTab(league, teams, fixtures, results));
    else if (tab === "fixtures") app.appendChild(renderFixturesTab(league, teams, fixtures, results));
    else if (tab === "standings") app.appendChild(renderStandingsTab(league, teams, fixtures, results));
    else if (tab === "playoffs") app.appendChild(renderPlayoffsTab(league, teams, fixtures, results));
    else if (tab === "confirmations") app.appendChild(renderConfirmationsTab(teams, fixtures, results));
    else if (tab === "disputes") app.appendChild(renderDisputesTab(teams, fixtures, results));
    else app.appendChild(renderSettingsTab(league));
  }

  // ---------- League-wide stats strip (shown above the tabs on every view) ----------

  function leagueStatsStrip(teams, fixtures, results) {
    const leagueFixtures = fixtures.filter((f) => f.stage === "league" && f.status !== "bye");
    const confirmedFixtureIds = new Set(
      results.filter((r) => r.confirmation_status === "confirmed" && !r.superseded).map((r) => r.fixture_id)
    );
    const completed = leagueFixtures.filter((f) => confirmedFixtureIds.has(f.id)).length;
    const remaining = leagueFixtures.length - completed;
    const pending = results.filter((r) => r.confirmation_status === "pending" && !r.superseded).length;
    const disputed = results.filter((r) => r.confirmation_status === "disputed" && !r.superseded).length;

    const outstandingWeeks = leagueFixtures.filter((f) => !confirmedFixtureIds.has(f.id)).map((f) => f.week);
    const currentWeek = outstandingWeeks.length ? Math.min(...outstandingWeeks) : null;

    const stats = [
      ["Teams", teams.length],
      ["Matches", leagueFixtures.length],
      ["Completed", completed],
      ["Remaining", remaining],
      ["Current week", currentWeek ? `Week ${currentWeek}` : leagueFixtures.length ? "Complete" : "—"],
      ["Pending", pending],
      ["Disputed", disputed]
    ];

    return el(
      "div",
      { class: "stats-strip" },
      stats.map(([label, value]) => el("div", { class: "stat-tile" }, [el("div", { class: "stat-value" }, String(value)), el("div", { class: "stat-label" }, label)]))
    );
  }

  // ---------- Standings tab ----------

  function renderStandingsTab(league, teams, fixtures, results) {
    if (!teams.length) {
      return el("div", { class: "card" }, el("p", { class: "empty-state" }, "Add teams to see a league table."));
    }
    const rows = window.Standings.computeStandings(teams, fixtures, results);
    return el("div", { class: "card" }, [el("h3", {}, "League table"), standingsTable(rows)]);
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
      el("div", { class: "standings-row" }, [
        el("span", {}, String(r.position)),
        el("span", { class: "standings-team" }, [r.team.name, !r.team.active ? badge("inactive", "neutral") : null]),
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

  // ---------- Playoffs tab ----------

  function renderPlayoffsTab(league, teams, fixtures, results) {
    const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
    const leagueFixtures = fixtures.filter((f) => f.stage === "league" && f.status !== "bye");
    const playoffFixtures = fixtures.filter((f) => f.stage !== "league");

    if (league.status === "completed" || league.status === "archived") {
      return el("div", { class: "stack" }, [championCard(league, playoffFixtures, results, teamsById), bracketView(playoffFixtures, results, teamsById)]);
    }

    if (!playoffFixtures.length) {
      const remaining = leagueFixtures.filter((f) => {
        const r = window.Results.activeResultForFixture(f.id, results);
        return !r || r.confirmation_status !== "confirmed";
      }).length;
      const standings = window.Standings.computeStandings(teams.filter((t) => t.active), fixtures, results);
      const qualifyCount = Math.min(league.playoff_size || 8, standings.length);

      return el("div", { class: "stack" }, [
        el("div", { class: "card" }, [
          el("h3", {}, "Start playoffs"),
          remaining > 0
            ? el("p", { class: "form-error" }, `${remaining} league match${remaining === 1 ? "" : "es"} still need${remaining === 1 ? "s" : ""} a confirmed result before playoffs can start.`)
            : el("p", { class: "muted" }, `Top ${qualifyCount} team${qualifyCount === 1 ? "" : "s"} will qualify based on the current league table.`),
          el(
            "button",
            { class: "btn btn-primary", type: "button", disabled: remaining > 0 || standings.length < 2, onclick: () => startPlayoffs(league, standings) },
            "Start playoffs"
          )
        ]),
        el("div", { class: "card" }, [el("h3", {}, "Current standings"), standingsTable(standings)])
      ]);
    }

    return bracketView(playoffFixtures, results, teamsById);
  }

  async function startPlayoffs(league, standings) {
    const bracketDefs = window.Playoffs.buildBracket(standings, league.playoff_size || 8);
    if (!bracketDefs.length) {
      alert("Not enough teams for a playoff bracket.");
      return;
    }
    const slotToId = {};
    const inserted = [];
    for (const def of bracketDefs) {
      const { next_bracket_slot, next_slot, ...rest } = def;
      const saved = await dbInsert("fixtures", { ...rest, league_id: league.id, week: 900, stage: def.stage });
      slotToId[def.bracket_slot] = saved.id;
      inserted.push({ id: saved.id, next_bracket_slot, next_slot });
    }
    for (const def of inserted) {
      if (def.next_bracket_slot) {
        await dbUpdate("fixtures", def.id, { next_fixture_id: slotToId[def.next_bracket_slot], next_slot: def.next_slot });
      }
    }
    await dbUpdate("leagues", league.id, { status: "playoffs" });
    render();
  }

  function bracketView(playoffFixtures, results, teamsById) {
    const byStage = {};
    playoffFixtures.forEach((f) => (byStage[f.stage] = byStage[f.stage] || []).push(f));
    const stageTitle = { QF: "Quarter-finals", SF: "Semi-finals", F: "Final" };

    return el(
      "div",
      { class: "stack" },
      window.Playoffs.STAGE_ORDER.filter((s) => byStage[s]).map((stage) =>
        el("div", { class: "card" }, [
          el("h3", {}, stageTitle[stage]),
          el(
            "div",
            { class: "stack" },
            byStage[stage].map((f) => playoffMatchRow(f, results, teamsById))
          )
        ])
      )
    );
  }

  function playoffMatchRow(fixture, results, teamsById) {
    const result = window.Results.activeResultForFixture(fixture.id, results);
    const canEnter = fixture.team1_id && fixture.team2_id;

    const row = el("div", { class: "fixture-row" }, [
      matchup(teamsById[fixture.team1_id], teamsById[fixture.team2_id]),
      resultBadge(result),
      canEnter && !result
        ? el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleEnterScore(fixture.id) }, enterScoreFixtures.has(fixture.id) ? "Cancel" : "Enter score")
        : null,
      canEnter && result
        ? el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleOverride(result.id) }, "Correct score")
        : null
    ]);

    if (canEnter && !result && enterScoreFixtures.has(fixture.id)) {
      return el("div", { class: "fixture-block" }, [row, overrideForm(fixture, null, false, teamsById)]);
    }
    if (canEnter && result && overrideForms.has(result.id)) {
      return el("div", { class: "fixture-block" }, [row, overrideForm(fixture, result, false, teamsById)]);
    }
    return row;
  }

  function championCard(league, playoffFixtures, results, teamsById) {
    const final = playoffFixtures.find((f) => f.stage === "F");
    const result = final ? window.Results.activeResultForFixture(final.id, results) : null;
    if (!final || !result || result.confirmation_status !== "confirmed") {
      return el("div", { class: "card" }, el("p", { class: "muted" }, "Champion will show here once the final is confirmed."));
    }
    const sw = window.Standings.setsWon(result);
    const championId = sw.team1 >= 2 ? final.team1_id : final.team2_id;
    const champion = teamsById[championId];
    return el("div", { class: "card champion-card" }, [
      el("div", {}, "🏆 LEAGUE CHAMPIONS"),
      el("h2", {}, champion ? champion.name : "Unknown"),
      champion ? el("p", { class: "muted" }, `${champion.player1} + ${champion.player2}`) : null,
      league.status === "completed"
        ? el("button", { class: "btn btn-primary", type: "button", onclick: () => archiveLeague(league) }, "Archive league")
        : badge("archived", "neutral")
    ]);
  }

  async function archiveLeague(league) {
    await dbUpdate("leagues", league.id, { status: "archived" });
    render();
  }

  // ---------- Teams tab ----------

  function renderTeamsTab(league, teams, fixtures, results) {
    const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
    const rows = teams.length
      ? teams.map((team) => teamRow(league, team, teams, fixtures, teamsById, results))
      : [el("p", { class: "empty-state" }, "No teams yet - add your fixed pairs above.")];

    return el("div", { class: "stack" }, [
      addTeamForm(league, teams),
      el("div", { class: "card" }, [el("h3", {}, `Teams (${teams.length})`), el("div", { class: "stack" }, rows)])
    ]);
  }

  function teamRow(league, team, allTeams, fixtures, teamsById, results) {
    const expanded = expandedTeams.has(team.id);
    const editing = editingTeams.has(team.id);
    const link = `${location.origin}${location.pathname.replace(/admin\.html$/, "")}team/${team.access_code}`;

    if (editing) {
      return el("div", { class: "team-row" }, [editTeamForm(team)]);
    }

    const header = el("div", { class: "team-row-header" }, [
      el("div", {}, [
        el("div", { class: "team-row-name" }, [team.name, !team.active && badge("inactive", "neutral")]),
        el("div", { class: "muted small" }, `${team.player1} + ${team.player2}`)
      ]),
      el("div", { class: "row-actions" }, [
        el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleEdit(team.id) }, "Edit"),
        el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleExpand(team.id) }, expanded ? "Hide fixtures" : "Fixtures"),
        el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleActive(team) }, team.active ? "Mark inactive" : "Mark active"),
        el("button", { class: "btn btn-danger small", type: "button", onclick: () => removeTeam(team, fixtures) }, "Delete")
      ])
    ]);

    const linkRow = el("div", { class: "team-link-row" }, [
      el("span", { class: "muted small" }, "Team link:"),
      el("code", { class: "code-chip" }, link),
      el("button", { class: "btn btn-ghost small", type: "button", onclick: () => copyToClipboard(link) }, "Copy")
    ]);

    const children = [header, linkRow];

    if (expanded) {
      const confirmedFixtureIds = new Set(
        results.filter((r) => r.confirmation_status === "confirmed" && !r.superseded).map((r) => r.fixture_id)
      );
      const { played, remaining } = window.Fixtures.opponentSplit(team.id, fixtures, confirmedFixtureIds);
      children.push(
        el("div", { class: "opponent-split" }, [
          opponentList("Played", played, teamsById, "✅"),
          opponentList("Still to play", remaining, teamsById, "⬜")
        ])
      );
    }

    return el("div", { class: "team-row" }, children);
  }

  function toggleEdit(teamId) {
    if (editingTeams.has(teamId)) editingTeams.delete(teamId);
    else editingTeams.add(teamId);
    render();
  }

  function editTeamForm(team) {
    const name = el("input", { class: "input", value: team.name });
    const player1 = el("input", { class: "input", value: team.player1 });
    const player2 = el("input", { class: "input", value: team.player2 });
    const error = el("p", { class: "form-error", hidden: true });

    const form = el("form", {}, [
      el("div", { class: "field-row three" }, [field("Team name", name), field("Player 1", player1), field("Player 2", player2)]),
      error,
      el("div", { class: "row-actions" }, [
        el("button", { class: "btn btn-primary small", type: "submit" }, "Save"),
        el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleEdit(team.id) }, "Cancel")
      ])
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!name.value.trim() || !player1.value.trim() || !player2.value.trim()) {
        error.hidden = false;
        error.textContent = "Team name and both players are required.";
        return;
      }
      await dbUpdate("teams", team.id, {
        name: name.value.trim(),
        player1: player1.value.trim(),
        player2: player2.value.trim()
      });
      editingTeams.delete(team.id);
      render();
    });

    return form;
  }

  function opponentList(title, entries, teamsById, icon) {
    return el("div", {}, [
      el("div", { class: "opponent-list-title" }, title),
      entries.length
        ? el(
            "ul",
            { class: "opponent-list" },
            entries.map((e) => el("li", {}, [el("span", { class: "opponent-list-icon" }, icon), teamBlock(teamsById[e.opponentId])]))
          )
        : el("p", { class: "muted small" }, "None")
    ]);
  }

  function addTeamForm(league, existingTeams) {
    const name = el("input", { class: "input", placeholder: "Team name, e.g. Smash Bros" });
    const player1 = el("input", { class: "input", placeholder: "Player 1" });
    const player2 = el("input", { class: "input", placeholder: "Player 2" });
    const error = el("p", { class: "form-error", hidden: true });

    const form = el("form", { class: "card" }, [
      el("h3", {}, "Add a team"),
      el("div", { class: "field-row three" }, [field("Team name", name), field("Player 1", player1), field("Player 2", player2)]),
      error,
      el("button", { class: "btn btn-primary", type: "submit" }, "Add team")
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!name.value.trim() || !player1.value.trim() || !player2.value.trim()) {
        error.hidden = false;
        error.textContent = "Team name and both players are required.";
        return;
      }
      const existingCodes = new Set(existingTeams.map((t) => t.access_code));
      let code = genAccessCode();
      while (existingCodes.has(code)) code = genAccessCode();

      await dbInsert("teams", {
        league_id: league.id,
        name: name.value.trim(),
        player1: player1.value.trim(),
        player2: player2.value.trim(),
        access_code: code,
        active: true
      });
      render();
    });

    return form;
  }

  function toggleExpand(teamId) {
    if (expandedTeams.has(teamId)) expandedTeams.delete(teamId);
    else expandedTeams.add(teamId);
    render();
  }

  async function toggleActive(team) {
    await dbUpdate("teams", team.id, { active: !team.active });
    render();
  }

  async function removeTeam(team, fixtures) {
    const hasFixtures = fixtures.some((f) => f.team1_id === team.id || f.team2_id === team.id);
    if (hasFixtures) {
      alert(
        `${team.name} already has fixtures/results in this league, so it can't be deleted outright (that would leave holes in other teams' schedules). ` +
          `Use "Mark inactive" instead to remove them from future scheduling while keeping their history intact - or, if you really want them gone, delete the whole league's fixtures first (Fixtures tab → Regenerate) then delete the team.`
      );
      return;
    }
    if (!confirm(`Delete ${team.name}? This can't be undone.`)) return;
    try {
      await dbDelete("teams", team.id);
    } catch (err) {
      alert(`Couldn't delete ${team.name}: ${err.message || err}`);
      return;
    }
    render();
  }

  function copyToClipboard(text) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  // ---------- Fixtures tab ----------

  function renderFixturesTab(league, teams, fixtures, results) {
    const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
    const activeTeams = teams.filter((t) => t.active);
    const leagueFixtures = fixtures.filter((f) => f.stage === "league");

    const playoffsStarted = league.status === "playoffs" || league.status === "completed" || league.status === "archived";
    const generateBtn = el(
      "button",
      {
        class: "btn btn-primary",
        type: "button",
        disabled: activeTeams.length < 2 || playoffsStarted,
        onclick: () => generateFixtures(league, activeTeams, leagueFixtures)
      },
      leagueFixtures.length ? "Regenerate fixtures" : "Generate fixtures"
    );

    const header = el("div", { class: "card" }, [
      el("div", { class: "field-row", style: "align-items:center;" }, [
        el("p", { class: "muted" }, `${activeTeams.length} active team${activeTeams.length === 1 ? "" : "s"} · ${league.num_courts || 1} court${league.num_courts === 1 ? "" : "s"}`),
        generateBtn
      ]),
      activeTeams.length < 2 ? el("p", { class: "form-error" }, "Add at least 2 active teams first.") : null,
      playoffsStarted ? el("p", { class: "muted small" }, "Playoffs have started - the league schedule is locked.") : null
    ]);

    if (!leagueFixtures.length) {
      return el("div", { class: "stack" }, [header, el("p", { class: "empty-state" }, "No fixtures generated yet.")]);
    }

    const byWeek = {};
    leagueFixtures.forEach((f) => (byWeek[f.week] = byWeek[f.week] || []).push(f));

    const weeks = Object.keys(byWeek)
      .map(Number)
      .sort((a, b) => a - b)
      .map((week) => weekCard(week, byWeek[week], teamsById, results));

    return el("div", { class: "stack" }, [header, ...weeks]);
  }

  const enterScoreFixtures = new Set();

  function weekCard(week, matches, teamsById, results) {
    matches.sort((a, b) => (a.time_slot || 0) - (b.time_slot || 0) || (a.court || 0) - (b.court || 0));
    return el("div", { class: "card" }, [
      el("h3", {}, `Week ${week}`),
      el(
        "div",
        { class: "stack" },
        matches.map((f) => {
          if (f.status === "bye") {
            return el("div", { class: "fixture-row muted" }, [teamBlock(teamsById[f.team1_id]), el("span", {}, "has a bye")]);
          }
          const result = window.Results.activeResultForFixture(f.id, results);
          const row = el("div", { class: "fixture-row" }, [
            el("span", { class: "court-tag" }, `Court ${f.court}${matches.length > 1 && f.time_slot > 1 ? ` · slot ${f.time_slot}` : ""}`),
            matchup(teamsById[f.team1_id], teamsById[f.team2_id]),
            resultBadge(result),
            !result
              ? el(
                  "button",
                  { class: "btn btn-ghost small", type: "button", onclick: () => toggleEnterScore(f.id) },
                  enterScoreFixtures.has(f.id) ? "Cancel" : "Enter score"
                )
              : null
          ]);
          if (!result && enterScoreFixtures.has(f.id)) {
            return el("div", { class: "fixture-block" }, [row, overrideForm(f, null, false, teamsById)]);
          }
          return row;
        })
      )
    ]);
  }

  function toggleEnterScore(fixtureId) {
    if (enterScoreFixtures.has(fixtureId)) enterScoreFixtures.delete(fixtureId);
    else enterScoreFixtures.add(fixtureId);
    render();
  }

  function resultBadge(result) {
    if (!result) return null;
    const sw = window.Standings.setsWon(result);
    const score = `${sw.team1}-${sw.team2}`;
    if (result.confirmation_status === "confirmed") return badge(`${score} confirmed`, "green");
    if (result.confirmation_status === "disputed") return badge(`${score} disputed`, "amber");
    return badge(`${score} pending`, "blue");
  }

  // Team name stays prominent; both players from that team's existing
  // record show underneath in smaller text - read live from teamsById,
  // never duplicated, so a rename in Teams shows up immediately everywhere
  // a fixture is displayed.
  function teamBlock(team) {
    if (!team) return el("span", {}, "TBD");
    return el("div", { class: "opponent-block" }, [
      el("div", { class: "opponent-block-name" }, team.name),
      el("div", { class: "opponent-block-players" }, `${team.player1} & ${team.player2}`)
    ]);
  }

  function matchup(team1, team2) {
    return el("div", { class: "matchup" }, [teamBlock(team1), el("div", { class: "matchup-vs" }, "vs"), teamBlock(team2)]);
  }

  async function generateFixtures(league, activeTeams, existingFixtures) {
    if (existingFixtures.length && !confirm("This replaces the current fixture list AND deletes any scores already recorded against it. Continue?")) return;
    for (const f of existingFixtures) await dbDelete("fixtures", f.id);
    const teamIds = activeTeams.map((t) => t.id);
    const generated = window.Fixtures.generateRoundRobin(teamIds, league.num_courts || 1);
    for (const f of generated) await dbInsert("fixtures", { ...f, league_id: league.id });
    if (league.status === "draft") await dbUpdate("leagues", league.id, { status: "active" });
    render();
  }

  // ---------- Confirmations tab ----------

  function renderConfirmationsTab(teams, fixtures, results) {
    const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
    const fixturesById = Object.fromEntries(fixtures.map((f) => [f.id, f]));
    const pending = results.filter((r) => r.confirmation_status === "pending" && !r.superseded);

    if (!pending.length) {
      return el("div", { class: "card" }, el("p", { class: "empty-state" }, "No results waiting on a confirmation right now."));
    }

    return el(
      "div",
      { class: "stack" },
      pending.map((result) => {
        const fixture = fixturesById[result.fixture_id];
        if (!fixture) return null;
        const submittedBy = teamsById[result.submitted_by_team_id];
        const sw = window.Standings.setsWon(result);
        return el("div", { class: "card" }, [
          el("div", { class: "fixture-row" }, [
            el("span", { class: "court-tag" }, `Week ${fixture.week}`),
            matchup(teamsById[fixture.team1_id], teamsById[fixture.team2_id]),
            el("strong", {}, `${sw.team1} - ${sw.team2}`)
          ]),
          el("p", { class: "muted small" }, `Sets: ${window.Render.formatSets(result)}`),
          el("p", { class: "muted small" }, `Submitted by ${submittedBy ? submittedBy.name : "unknown team"}`),
          el("div", { class: "row-actions" }, [
            el("button", { class: "btn btn-primary small", type: "button", onclick: () => forceConfirm(result) }, "Force confirm"),
            el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleOverride(result.id) }, "Correct score")
          ]),
          overrideForms.has(result.id) ? overrideForm(fixture, result, false, teamsById) : null
        ]);
      })
    );
  }

  async function forceConfirm(result) {
    await window.Results.confirmResult(result, null);
    render();
  }

  // ---------- Disputes tab ----------

  function renderDisputesTab(teams, fixtures, results) {
    const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
    const fixturesById = Object.fromEntries(fixtures.map((f) => [f.id, f]));
    const disputed = results.filter((r) => r.confirmation_status === "disputed" && !r.superseded);

    if (!disputed.length) {
      return el("div", { class: "card" }, el("p", { class: "empty-state" }, "No disputed results."));
    }

    return el(
      "div",
      { class: "stack" },
      disputed.map((result) => {
        const fixture = fixturesById[result.fixture_id];
        if (!fixture) return null;
        const sw = window.Standings.setsWon(result);
        return el("div", { class: "card" }, [
          el("div", { class: "fixture-row" }, [
            el("span", { class: "court-tag" }, `Week ${fixture.week}`),
            matchup(teamsById[fixture.team1_id], teamsById[fixture.team2_id]),
            el("strong", {}, `${sw.team1} - ${sw.team2}`),
            badge("disputed", "amber")
          ]),
          el("p", { class: "muted small" }, `Sets: ${window.Render.formatSets(result)}`),
          result.dispute_reason ? el("p", { class: "muted small" }, `Reason given: ${result.dispute_reason}`) : null,
          overrideForm(fixture, result, true, teamsById)
        ]);
      })
    );
  }

  const overrideForms = new Set();

  function toggleOverride(resultId) {
    if (overrideForms.has(resultId)) overrideForms.delete(resultId);
    else overrideForms.add(resultId);
    render();
  }

  // Same compact score-grid component the team-facing "Submit result" form
  // uses (window.Render.scoreGrid/scoreInput/wireAutoAdvance) - kept as one
  // shared component specifically so admin and player score entry can't
  // drift back into two separate designs.
  function overrideForm(fixture, oldResult, alwaysOpen, teamsById) {
    const team1 = teamsById[fixture.team1_id];
    const team2 = teamsById[fixture.team2_id];
    const team1Inputs = [1, 2, 3].map((n) => {
      const input = scoreInput();
      if (oldResult) input.value = oldResult[`set${n}_team1_score`];
      return input;
    });
    const team2Inputs = [1, 2, 3].map((n) => {
      const input = scoreInput();
      if (oldResult) input.value = oldResult[`set${n}_team2_score`];
      return input;
    });
    // Interleaved (team1 S1, team2 S1, team1 S2, ...) rather than the
    // grid's row-major DOM order - matches entering both teams' numbers for
    // one set before moving to the next, same as the team-facing form.
    wireAutoAdvance([team1Inputs[0], team2Inputs[0], team1Inputs[1], team2Inputs[1], team1Inputs[2], team2Inputs[2]]);
    const error = el("p", { class: "form-error", hidden: true });

    const grid = scoreGrid(teamBlock(team1), team1Inputs, teamBlock(team2), team2Inputs);

    const saveLabel = oldResult ? "Save correct score" : "Save score";
    const saveBtn = el("button", { class: "btn btn-primary small", type: "submit" }, saveLabel);
    const form = el("form", { class: alwaysOpen ? "" : "inline-form" }, [grid, error, saveBtn]);
    let isSaving = false;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (isSaving) return;
      const team1Sets = team1Inputs.map((i) => i.value);
      const team2Sets = team2Inputs.map((i) => i.value);
      if (team1Sets.some((v) => v === "") || team2Sets.some((v) => v === "")) {
        error.hidden = false;
        error.textContent = "Enter all 3 sets for both teams.";
        return;
      }
      const t1 = team1Sets.map(Number);
      const t2 = team2Sets.map(Number);
      if (t1.some((v, i) => v === t2[i])) {
        error.hidden = false;
        error.textContent = "A set can't be tied - one team must win each set.";
        return;
      }

      isSaving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      error.hidden = true;
      try {
        await window.Results.adminSetResult(fixture, oldResult, t1, t2);
        if (oldResult) overrideForms.delete(oldResult.id);
        else enterScoreFixtures.delete(fixture.id);
        render();
      } catch (err) {
        console.error(err);
        isSaving = false;
        saveBtn.disabled = false;
        saveBtn.textContent = saveLabel;
        error.hidden = false;
        error.textContent = "Couldn't save - check your connection and try again. Your scores are still here.";
      }
    });

    return form;
  }

  // ---------- Settings tab ----------

  function renderSettingsTab(league) {
    const name = el("input", { class: "input", value: league.name });
    const description = el("input", { class: "input", value: league.description || "" });
    const startDate = el("input", { class: "input", type: "date", value: league.start_date || "" });
    const numCourts = el("input", { class: "input", type: "number", min: "1", value: league.num_courts || 1 });
    const availability = toggleField("Team availability", league.availability_enabled !== false);
    const saved = el("span", { class: "save-confirm", hidden: true }, "Saved");

    const form = el("form", { class: "card" }, [
      el("h3", {}, "League settings"),
      field("League name", name),
      field("Description", description),
      el("div", { class: "field-row" }, [field("Start date", startDate), field("Number of courts", numCourts)]),
      el("div", { class: "toggle-row" }, [
        availability.label,
        el(
          "p",
          { class: "muted small" },
          "Lets teams share weekly availability and see their opponent's, on their shared team link. Turn off to hide it everywhere for players - nothing already saved is deleted."
        )
      ]),
      el("div", { class: "field-row", style: "align-items:center;" }, [
        el("button", { class: "btn btn-primary", type: "submit" }, "Save changes"),
        saved
      ])
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await dbUpdate("leagues", league.id, {
        name: name.value.trim(),
        description: description.value.trim() || null,
        start_date: startDate.value || null,
        num_courts: Number(numCourts.value) || 1,
        availability_enabled: availability.input.checked
      });
      saved.hidden = false;
      setTimeout(() => (saved.hidden = true), 1500);
    });

    return el("div", { class: "stack" }, [form, endLeagueCard(league), deleteLeagueCard(league)]);
  }

  // A checkbox styled as a pill switch (see .switch in style.css). Returns
  // both the wrapping <label> to render and the raw <input> so the caller
  // can read .checked at submit time.
  function toggleField(labelText, checked) {
    const input = el("input", { type: "checkbox", checked: checked || undefined });
    const label = el("label", { class: "switch" }, [input, el("span", { class: "switch-track" }), el("span", { class: "switch-label" }, labelText)]);
    return { label, input };
  }

  function endLeagueCard(league) {
    if (league.status === "archived") {
      return el("div", { class: "card" }, [el("h3", {}, "End league"), el("p", { class: "muted" }, "This league is already archived.")]);
    }
    return el("div", { class: "card" }, [
      el("h3", {}, "End league"),
      el("p", { class: "muted" }, "Marks the league as finished and moves it out of the active list. Nothing is deleted - teams, fixtures, and results stay viewable forever."),
      el(
        "button",
        {
          class: "btn btn-ghost",
          type: "button",
          onclick: async () => {
            if (!confirm(`End "${league.name}" now? You can't resume it once archived.`)) return;
            await dbUpdate("leagues", league.id, { status: "archived" });
            render();
          }
        },
        "End league"
      )
    ]);
  }

  function deleteLeagueCard(league) {
    const confirmName = el("input", { class: "input", placeholder: `Type "${league.name}" to confirm` });
    const deleteBtn = el("button", { class: "btn btn-danger", type: "button", disabled: true }, "Delete league permanently");

    confirmName.addEventListener("input", () => {
      deleteBtn.disabled = confirmName.value.trim() !== league.name;
    });

    deleteBtn.addEventListener("click", async () => {
      if (confirmName.value.trim() !== league.name) return;
      deleteBtn.disabled = true;
      deleteBtn.textContent = "Deleting...";
      await deleteLeagueCompletely(league);
    });

    return el("div", { class: "card danger-card" }, [
      el("h3", {}, "Delete league"),
      el("p", { class: "muted" }, "Permanently removes this league and every team, fixture, and result in it. This cannot be undone."),
      confirmName,
      deleteBtn
    ]);
  }

  async function deleteLeagueCompletely(league) {
    // Delete fixtures ourselves in dependency order (league-stage, then
    // QF/SF/F) rather than relying on the DB cascade, since a fixture with
    // an active next_fixture_id pointer can't be deleted while something
    // still points to it.
    const stageOrder = { league: 0, QF: 1, SF: 2, F: 3 };
    const fixtures = await dbList("fixtures", { league_id: `eq.${league.id}` });
    fixtures.sort((a, b) => (stageOrder[a.stage] ?? 0) - (stageOrder[b.stage] ?? 0));
    for (const f of fixtures) await dbDelete("fixtures", f.id);
    // Results cascade-delete with their fixture; teams cascade-delete with the league.
    await dbDelete("leagues", league.id);
    navigate("#/leagues");
  }
})();
