// Team dashboard: resolves ?code=... (or a remembered code) to a team, then
// shows that team's own fixtures and opponent tracking. Score submission and
// confirmation land in Phase 2.
(function () {
  const { el, qs } = window.Render;
  const { dbList } = window.DB;

  const app = document.getElementById("app");

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
      await renderTeamHome(code);
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

  async function renderTeamHome(code) {
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
            {
              class: "btn btn-ghost",
              type: "button",
              onclick: () => {
                window.State.forgetTeamCode();
                location.reload();
              }
            },
            "Try a different code"
          )
        ])
      );
      return;
    }

    const [league, allTeams, fixtures] = await Promise.all([
      dbList("leagues", { id: `eq.${team.league_id}` }).then((r) => r[0]),
      dbList("teams", { league_id: `eq.${team.league_id}` }),
      dbList("fixtures", { league_id: `eq.${team.league_id}` })
    ]);
    const teamsById = Object.fromEntries(allTeams.map((t) => [t.id, t]));

    app.innerHTML = "";
    app.appendChild(
      el("div", { class: "card team-hero" }, [
        el("div", { class: "muted small" }, league ? league.name : ""),
        el("h2", {}, team.name),
        el("p", { class: "muted" }, `${team.player1} + ${team.player2}`)
      ])
    );

    const confirmedFixtureIds = new Set(); // wired once results exist (Phase 2)
    const myFixtures = fixtures.filter((f) => f.stage === "league" && (f.team1_id === team.id || f.team2_id === team.id));
    const { played, remaining } = window.Fixtures.opponentSplit(team.id, fixtures, confirmedFixtureIds);

    app.appendChild(
      el("div", { class: "card" }, [
        el("h3", {}, "My fixtures"),
        myFixtures.length
          ? el(
              "div",
              { class: "stack" },
              myFixtures
                .sort((a, b) => a.week - b.week)
                .map((f) => {
                  const oppId = f.team1_id === team.id ? f.team2_id : f.team1_id;
                  const oppName = oppId ? (teamsById[oppId] ? teamsById[oppId].name : "Unknown") : null;
                  return el("div", { class: "fixture-row" }, [
                    el("span", { class: "court-tag" }, `Week ${f.week}`),
                    el("span", {}, oppName ? `vs ${oppName}` : "Bye week")
                  ]);
                })
            )
          : el("p", { class: "empty-state" }, "Fixtures haven't been generated yet - check back once your admin sets the schedule.")
      ])
    );

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

  function opponentList(title, entries, teamsById, icon) {
    return el("div", {}, [
      el("div", { class: "opponent-list-title" }, title),
      entries.length
        ? el("ul", { class: "opponent-list" }, entries.map((e) => el("li", {}, `${icon} ${teamsById[e.opponentId] ? teamsById[e.opponentId].name : "Unknown"}`)))
        : el("p", { class: "muted small" }, "None")
    ]);
  }
})();
