// Team dashboard: resolves ?code=... (or a remembered code) to a team, then
// shows that team's fixtures with score submission / confirmation / dispute.
// Write-path logic lives in results.js - this file is DOM glue only.
(function () {
  const { el, qs } = window.Render;
  const { dbList } = window.DB;

  const app = document.getElementById("app");
  const openSubmitForms = new Set();
  let ctx = null; // { team, league, teamsById, fixtures, results }

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    const codeFromUrl = qs("code");
    if (codeFromUrl) window.State.rememberTeamCode(codeFromUrl.toUpperCase());
    const code = (codeFromUrl || window.State.getRememberedTeamCode() || "").toUpperCase();

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

    const [league, allTeams, fixtures, allResults] = await Promise.all([
      dbList("leagues", { id: `eq.${team.league_id}` }).then((r) => r[0]),
      dbList("teams", { league_id: `eq.${team.league_id}` }),
      dbList("fixtures", { league_id: `eq.${team.league_id}` }),
      dbList("results")
    ]);
    const teamsById = Object.fromEntries(allTeams.map((t) => [t.id, t]));
    const fixtureIds = new Set(fixtures.map((f) => f.id));
    const results = allResults.filter((r) => fixtureIds.has(r.fixture_id));

    ctx = { team, league, teamsById, fixtures, results };
    render();
  }

  function render() {
    const { team, league, teamsById, fixtures, results } = ctx;
    app.innerHTML = "";

    app.appendChild(
      el("div", { class: "card team-hero" }, [
        el("div", { class: "muted small" }, league ? league.name : ""),
        el("h2", {}, team.name),
        el("p", { class: "muted" }, `${team.player1} + ${team.player2}`)
      ])
    );

    const confirmedFixtureIds = new Set(
      results.filter((r) => r.confirmation_status === "confirmed" && !r.superseded).map((r) => r.fixture_id)
    );
    const myFixtures = fixtures.filter((f) => f.stage === "league" && (f.team1_id === team.id || f.team2_id === team.id));

    app.appendChild(
      el("div", { class: "card" }, [
        el("h3", {}, "My fixtures"),
        myFixtures.length
          ? el("div", { class: "stack" }, myFixtures.sort((a, b) => a.week - b.week).map((f) => fixtureRow(f)))
          : el("p", { class: "empty-state" }, "Fixtures haven't been generated yet - check back once your admin sets the schedule.")
      ])
    );

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
  }

  function fixtureRow(f) {
    const { team, teamsById, results } = ctx;

    if (f.status === "bye" || f.team2_id == null) {
      return el("div", { class: "fixture-row muted" }, [el("span", { class: "court-tag" }, `Week ${f.week}`), el("span", {}, "Bye week")]);
    }

    const oppId = f.team1_id === team.id ? f.team2_id : f.team1_id;
    const oppName = teamsById[oppId] ? teamsById[oppId].name : "Unknown";
    const result = window.Results.activeResultForFixture(f.id, results);
    const isTeam1 = f.team1_id === team.id;

    const base = [el("span", { class: "court-tag" }, `Week ${f.week}`), el("span", {}, `vs ${oppName}`)];

    if (!result) {
      const open = openSubmitForms.has(f.id);
      return el("div", { class: "fixture-block" }, [
        el("div", { class: "fixture-row" }, [
          ...base,
          el("button", { class: "btn btn-ghost small", type: "button", onclick: () => toggleSubmitForm(f.id) }, open ? "Cancel" : "Submit result")
        ]),
        open ? submitForm(f, isTeam1, oppName) : null
      ]);
    }

    const myScore = isTeam1 ? result.team1_score : result.team2_score;
    const oppScore = isTeam1 ? result.team2_score : result.team1_score;
    const scoreText = `${myScore}-${oppScore}`;

    if (result.confirmation_status === "confirmed") {
      return el("div", { class: "fixture-row" }, [...base, window.Render.badge(`${scoreText} confirmed`, "green")]);
    }

    if (result.confirmation_status === "disputed") {
      return el("div", { class: "fixture-row" }, [...base, window.Render.badge(`${scoreText} disputed`, "amber")]);
    }

    // pending
    const iSubmitted = result.submitted_by_team_id === team.id;
    if (iSubmitted) {
      return el("div", { class: "fixture-row" }, [...base, window.Render.badge(`${scoreText} awaiting confirmation`, "blue")]);
    }

    const disputeReason = el("input", { class: "input", placeholder: "Optional reason for admin" });
    return el("div", { class: "fixture-block" }, [
      el("div", { class: "fixture-row" }, [...base, el("strong", {}, scoreText)]),
      el("div", { class: "row-actions" }, [
        el("button", { class: "btn btn-primary small", type: "button", onclick: () => doConfirm(result) }, "Confirm result"),
        el("button", { class: "btn btn-danger small", type: "button", onclick: () => doDispute(result, disputeReason.value) }, "Dispute result")
      ]),
      disputeReason
    ]);
  }

  function submitForm(fixture, isTeam1, oppName) {
    const myScore = el("input", { class: "input", type: "number", min: "0", placeholder: "Your score" });
    const oppScore = el("input", { class: "input", type: "number", min: "0", placeholder: `${oppName}'s score` });
    const error = el("p", { class: "form-error", hidden: true });

    const form = el("form", { class: "card inline-form" }, [
      el("div", { class: "field-row" }, [field("Your score", myScore), field(`${oppName}'s score`, oppScore)]),
      error,
      el("button", { class: "btn btn-primary small", type: "submit" }, "Submit result")
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (myScore.value === "" || oppScore.value === "") {
        error.hidden = false;
        error.textContent = "Enter both scores.";
        return;
      }
      await window.Results.submitResult(fixture, ctx.team.id, Number(myScore.value), Number(oppScore.value));
      openSubmitForms.delete(fixture.id);
      await loadAndRender(ctx.team.access_code);
    });

    return form;
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
    await loadAndRender(ctx.team.access_code);
  }

  async function doDispute(result, reason) {
    await window.Results.disputeResult(result, reason);
    await loadAndRender(ctx.team.access_code);
  }

  function opponentList(title, entries, teamsById, icon) {
    return el("div", {}, [
      el("div", { class: "opponent-list-title" }, title),
      entries.length
        ? el("ul", { class: "opponent-list" }, entries.map((e) => el("li", {}, `${icon} ${teamsById[e.opponentId] ? teamsById[e.opponentId].name : "Unknown"}`)))
        : el("p", { class: "muted small" }, "None")
    ]);
  }
})();
