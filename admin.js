// Admin console: league + team CRUD, fixture generation, fixture/opponent views.
// DOM glue only - all scheduling math lives in fixtures.js.
(function () {
  const { el, formatDate, badge, genAccessCode } = window.Render;
  const { dbList, dbGet, dbInsert, dbUpdate, dbDelete } = window.DB;

  const app = document.getElementById("app");
  const expandedTeams = new Set();

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

  window.addEventListener("hashchange", render);
  document.addEventListener("DOMContentLoaded", render);

  async function render() {
    const route = parseHash();
    app.innerHTML = "";
    app.appendChild(el("p", { class: "loading" }, "Loading..."));
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
    const winPts = el("input", { class: "input", type: "number", value: "3" });
    const drawPts = el("input", { class: "input", type: "number", value: "1" });
    const lossPts = el("input", { class: "input", type: "number", value: "0" });
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
      el("div", { class: "field-row three" }, [
        field("Points per win", winPts),
        field("Points per draw", drawPts),
        field("Points per loss", lossPts)
      ]),
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
        scoring_config: { win: Number(winPts.value) || 0, draw: Number(drawPts.value) || 0, loss: Number(lossPts.value) || 0 },
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
    const [league, teams, fixtures, allResults] = await Promise.all([
      dbGet("leagues", leagueId),
      dbList("teams", { league_id: `eq.${leagueId}` }),
      dbList("fixtures", { league_id: `eq.${leagueId}` }),
      dbList("results")
    ]);

    app.innerHTML = "";
    if (!league) {
      app.appendChild(el("div", { class: "card" }, "League not found."));
      return;
    }

    const fixtureIds = new Set(fixtures.map((f) => f.id));
    const results = allResults.filter((r) => fixtureIds.has(r.fixture_id));
    const pendingCount = results.filter((r) => r.confirmation_status === "pending" && !r.superseded).length;
    const disputedCount = results.filter((r) => r.confirmation_status === "disputed" && !r.superseded).length;

    app.appendChild(
      el("div", { class: "detail-header" }, [
        el("a", { class: "back-link", href: "#/leagues" }, "← All leagues"),
        el("h2", {}, league.name),
        badge(league.status, statusKind(league.status))
      ])
    );

    const tabLabels = {
      teams: "Teams",
      fixtures: "Fixtures",
      confirmations: `Confirmations${pendingCount ? ` (${pendingCount})` : ""}`,
      disputes: `Disputes${disputedCount ? ` (${disputedCount})` : ""}`,
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
    else if (tab === "confirmations") app.appendChild(renderConfirmationsTab(teams, fixtures, results));
    else if (tab === "disputes") app.appendChild(renderDisputesTab(teams, fixtures, results));
    else app.appendChild(renderSettingsTab(league));
  }

  // ---------- Teams tab ----------

  function renderTeamsTab(league, teams, fixtures, results) {
    const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
    const rows = teams.length
      ? teams.map((team) => teamRow(league, team, teams, fixtures, teamsById, results))
      : [el("p", { class: "empty-state" }, "No teams yet - add your fixed pairs below.")];

    return el("div", { class: "stack" }, [
      el("div", { class: "card" }, [el("h3", {}, `Teams (${teams.length})`), el("div", { class: "stack" }, rows)]),
      addTeamForm(league, teams)
    ]);
  }

  function teamRow(league, team, allTeams, fixtures, teamsById, results) {
    const expanded = expandedTeams.has(team.id);
    const link = `${location.origin}${location.pathname.replace(/admin\.html$/, "")}team.html?code=${team.access_code}`;

    const header = el("div", { class: "team-row-header" }, [
      el("div", {}, [
        el("div", { class: "team-row-name" }, [team.name, !team.active && badge("inactive", "neutral")]),
        el("div", { class: "muted small" }, `${team.player1} + ${team.player2}`)
      ]),
      el("div", { class: "row-actions" }, [
        el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleExpand(team.id) }, expanded ? "Hide fixtures" : "Fixtures"),
        el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleActive(team) }, team.active ? "Mark inactive" : "Mark active"),
        el("button", { class: "btn btn-danger small", type: "button", onclick: () => removeTeam(team) }, "Delete")
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

  function opponentList(title, entries, teamsById, icon) {
    return el("div", {}, [
      el("div", { class: "opponent-list-title" }, title),
      entries.length
        ? el(
            "ul",
            { class: "opponent-list" },
            entries.map((e) => el("li", {}, `${icon} ${teamsById[e.opponentId] ? teamsById[e.opponentId].name : "Unknown"}`))
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

  async function removeTeam(team) {
    if (!confirm(`Delete ${team.name}? This can't be undone.`)) return;
    await dbDelete("teams", team.id);
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

    const generateBtn = el(
      "button",
      {
        class: "btn btn-primary",
        type: "button",
        disabled: activeTeams.length < 2,
        onclick: () => generateFixtures(league, activeTeams, fixtures)
      },
      leagueFixtures.length ? "Regenerate fixtures" : "Generate fixtures"
    );

    const header = el("div", { class: "card" }, [
      el("div", { class: "field-row", style: "align-items:center;" }, [
        el("p", { class: "muted" }, `${activeTeams.length} active team${activeTeams.length === 1 ? "" : "s"} · ${league.num_courts || 1} court${league.num_courts === 1 ? "" : "s"}`),
        generateBtn
      ]),
      activeTeams.length < 2 ? el("p", { class: "form-error" }, "Add at least 2 active teams first.") : null
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
          if (f.status === "bye") return el("div", { class: "fixture-row muted" }, `${teamName(f.team1_id, teamsById)} has a bye`);
          const result = window.Results.activeResultForFixture(f.id, results);
          const row = el("div", { class: "fixture-row" }, [
            el("span", { class: "court-tag" }, `Court ${f.court}${matches.length > 1 && f.time_slot > 1 ? ` · slot ${f.time_slot}` : ""}`),
            el("span", {}, `${teamName(f.team1_id, teamsById)} vs ${teamName(f.team2_id, teamsById)}`),
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
            return el("div", { class: "fixture-block" }, [row, overrideForm(f, null)]);
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
    const score = `${result.team1_score}-${result.team2_score}`;
    if (result.confirmation_status === "confirmed") return badge(`${score} confirmed`, "green");
    if (result.confirmation_status === "disputed") return badge(`${score} disputed`, "amber");
    return badge(`${score} pending`, "blue");
  }

  function teamName(id, teamsById) {
    return teamsById[id] ? teamsById[id].name : "Unknown";
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
        return el("div", { class: "card" }, [
          el("div", { class: "fixture-row" }, [
            el("span", { class: "court-tag" }, `Week ${fixture.week}`),
            el("strong", {}, `${teamName(fixture.team1_id, teamsById)} ${result.team1_score} - ${result.team2_score} ${teamName(fixture.team2_id, teamsById)}`)
          ]),
          el("p", { class: "muted small" }, `Submitted by ${submittedBy ? submittedBy.name : "unknown team"}`),
          el("div", { class: "row-actions" }, [
            el("button", { class: "btn btn-primary small", type: "button", onclick: () => forceConfirm(result) }, "Force confirm"),
            el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleOverride(result.id) }, "Correct score")
          ]),
          overrideForms.has(result.id) ? overrideForm(fixture, result) : null
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
        return el("div", { class: "card" }, [
          el("div", { class: "fixture-row" }, [
            el("span", { class: "court-tag" }, `Week ${fixture.week}`),
            el("strong", {}, `${teamName(fixture.team1_id, teamsById)} ${result.team1_score} - ${result.team2_score} ${teamName(fixture.team2_id, teamsById)}`),
            badge("disputed", "amber")
          ]),
          result.dispute_reason ? el("p", { class: "muted small" }, `Reason given: ${result.dispute_reason}`) : null,
          overrideForm(fixture, result, true)
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

  function overrideForm(fixture, oldResult, alwaysOpen) {
    const score1 = el("input", { class: "input", type: "number", min: "0", value: oldResult ? oldResult.team1_score : 0 });
    const score2 = el("input", { class: "input", type: "number", min: "0", value: oldResult ? oldResult.team2_score : 0 });
    const error = el("p", { class: "form-error", hidden: true });

    const form = el("form", { class: alwaysOpen ? "" : "inline-form" }, [
      el("div", { class: "field-row" }, [field("Score 1", score1), field("Score 2", score2)]),
      error,
      el("button", { class: "btn btn-primary small", type: "submit" }, oldResult ? "Save correct score" : "Save score")
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (score1.value === "" || score2.value === "") {
        error.hidden = false;
        error.textContent = "Enter both scores.";
        return;
      }
      await window.Results.adminSetResult(fixture, oldResult, Number(score1.value), Number(score2.value));
      if (oldResult) overrideForms.delete(oldResult.id);
      else enterScoreFixtures.delete(fixture.id);
      render();
    });

    return form;
  }

  // ---------- Settings tab ----------

  function renderSettingsTab(league) {
    const name = el("input", { class: "input", value: league.name });
    const description = el("input", { class: "input", value: league.description || "" });
    const startDate = el("input", { class: "input", type: "date", value: league.start_date || "" });
    const numCourts = el("input", { class: "input", type: "number", min: "1", value: league.num_courts || 1 });
    const winPts = el("input", { class: "input", type: "number", value: league.scoring_config?.win ?? 3 });
    const drawPts = el("input", { class: "input", type: "number", value: league.scoring_config?.draw ?? 1 });
    const lossPts = el("input", { class: "input", type: "number", value: league.scoring_config?.loss ?? 0 });
    const saved = el("span", { class: "save-confirm", hidden: true }, "Saved");

    const form = el("form", { class: "card" }, [
      el("h3", {}, "League settings"),
      field("League name", name),
      field("Description", description),
      el("div", { class: "field-row" }, [field("Start date", startDate), field("Number of courts", numCourts)]),
      el("div", { class: "field-row three" }, [field("Points per win", winPts), field("Points per draw", drawPts), field("Points per loss", lossPts)]),
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
        scoring_config: { win: Number(winPts.value) || 0, draw: Number(drawPts.value) || 0, loss: Number(lossPts.value) || 0 }
      });
      saved.hidden = false;
      setTimeout(() => (saved.hidden = true), 1500);
    });

    return form;
  }
})();
