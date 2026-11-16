// An organiser's own leagues (my-leagues.html), across possibly-shared
// leagues (see migration_007 - a league can have multiple admins now).
// Genuinely server-filtered: league_admins is fetched with the caller's own
// JWT, so RLS only ever returns rows for their own auth.uid() - not a
// client-side filter over a full fetch. "Open league" reuses the existing
// admin.html console unchanged.
(function () {
  const { el, formatDate, badge } = window.Render;
  const { dbList } = window.DB;

  const app = document.getElementById("app");

  document.addEventListener("DOMContentLoaded", render);

  async function render() {
    if (!app.hasChildNodes()) {
      app.appendChild(window.Render.skeleton());
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

    // Two steps rather than one filtered leagues query: league_admins' own
    // RLS policy is what actually enforces "only this organiser's rows",
    // then leagues is fetched by exactly those ids - PostgREST doesn't
    // support filtering leagues through the join in a single plain query
    // the way this app's raw-fetch db.js talks to it.
    const memberships = await dbList("league_admins", { organiser_id: `eq.${organiser.id}` });
    const leagueIds = memberships.map((m) => m.league_id);
    const leagues = leagueIds.length ? await dbList("leagues", { id: `in.(${leagueIds.join(",")})` }) : [];
    // Which of them still need their R50 activation (a league with no row
    // there never needed one).
    const activations = leagueIds.length ? await dbList("league_activation_status", { league_id: `in.(${leagueIds.join(",")})` }) : [];
    const unpaid = new Set(activations.filter((a) => !a.paid).map((a) => a.league_id));
    app.innerHTML = "";

    // (Log out lives in the account menu in the top bar.)
    app.appendChild(
      window.Render.pageHead("My leagues", `Welcome back, ${organiser.name}.`, [
        el("a", { class: "btn btn-primary", href: "admin.html#/new" }, "+ Create a league")
      ])
    );

    app.appendChild(
      el("div", { class: "card" }, [
        leagues.length
          ? el("div", { class: "stack" }, leagues.map((l) => leagueCard(l, unpaid.has(l.id))))
          : window.Render.emptyState(
              "trophy",
              "You haven't created a league yet. Each league costs R50 to activate.",
              el("a", { class: "btn btn-primary", href: "admin.html#/new" }, "Create your first league")
            )
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

  function leagueCard(league, needsActivation) {
    // A league that hasn't paid its R50 opens on the pay screen.
    const href = `admin.html#/league/${league.id}/${needsActivation ? "activate" : "teams"}`;
    return el("a", { class: "league-row", href }, [
      el("div", {}, [
        el("div", { class: "league-row-name" }, league.name),
        el("div", { class: "muted small" }, [
          league.num_teams ? `${league.num_teams} teams target` : "",
          league.start_date ? ` · starts ${formatDate(league.start_date)}` : ""
        ].join(""))
      ]),
      needsActivation ? badge("not activated", "amber") : badge(league.status, statusKind(league.status))
    ]);
  }
})();
