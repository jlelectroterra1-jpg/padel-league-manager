// An organiser's own leagues (my-leagues.html). Only ever fetches leagues
// scoped to the signed-in organiser's own id - a client-side query filter,
// not a new database-enforced boundary (see migration_005's closing
// comment for why). "Open league" reuses the existing admin.html console
// unchanged.
(function () {
  const { el, formatDate, badge } = window.Render;
  const { dbList } = window.DB;

  const app = document.getElementById("app");

  document.addEventListener("DOMContentLoaded", render);

  async function render() {
    if (!app.hasChildNodes()) {
      app.appendChild(el("p", { class: "loading" }, "Loading..."));
    }
    if (!window.DB.hasSupabase()) {
      app.innerHTML = "";
      app.appendChild(
        el("div", { class: "card" }, [
          el("h3", {}, "Supabase not configured"),
          el("p", { class: "muted" }, "Organiser accounts need a configured Supabase project (see config.js) - this page can't run against the local fallback storage.")
        ])
      );
      return;
    }

    const organiser = await window.Auth.requireRole(["organiser"], { mustBeActive: true });
    if (!organiser) return; // requireRole already redirected

    const leagues = await dbList("leagues", { organiser_id: `eq.${organiser.id}` });
    app.innerHTML = "";

    app.appendChild(
      el("div", { class: "detail-header" }, [
        el("h2", {}, `Welcome, ${organiser.name}`),
        el("button", { class: "btn btn-ghost small", type: "button", onclick: () => logout() }, "Log out")
      ])
    );

    app.appendChild(
      el("div", { class: "card" }, [
        el("h3", {}, "My leagues"),
        leagues.length
          ? el("div", { class: "stack" }, leagues.map(leagueCard))
          : el("p", { class: "empty-state" }, "No leagues assigned to you yet - contact the league owner.")
      ])
    );
  }

  async function logout() {
    await window.Auth.signOut();
    location.href = "login.html";
  }

  function statusKind(status) {
    return { draft: "neutral", active: "blue", playoffs: "amber", completed: "green", archived: "neutral" }[status] || "neutral";
  }

  function leagueCard(league) {
    return el("a", { class: "league-row", href: `admin.html#/league/${league.id}/teams` }, [
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
})();
