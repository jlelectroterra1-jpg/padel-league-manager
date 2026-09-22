// Owner dashboard (owner.html): platform-wide stats, an organisers table
// (approve/suspend/reactivate), and a leagues table (open + assign to an
// organiser). DOM glue only - reuses the existing admin.html league-card
// look/link, never rebuilds it.
(function () {
  const { el, formatDate, badge } = window.Render;
  const { dbList, dbUpdate } = window.DB;

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
          el("p", { class: "muted" }, "Owner/organiser accounts need a configured Supabase project (see config.js) - this page can't run against the local fallback storage.")
        ])
      );
      return;
    }

    const owner = await window.Auth.requireRole(["owner"]);
    if (!owner) return; // requireRole already redirected

    const [organisers, leagues] = await Promise.all([dbList("organisers"), dbList("leagues")]);
    app.innerHTML = "";

    app.appendChild(
      el("div", { class: "detail-header" }, [
        el("h2", {}, "Owner dashboard"),
        el("button", { class: "btn btn-ghost small", type: "button", onclick: () => logout() }, "Log out")
      ])
    );

    app.appendChild(statsStrip(organisers, leagues));
    app.appendChild(organisersCard(organisers, leagues));
    app.appendChild(leaguesCard(leagues, organisers));
  }

  async function logout() {
    await window.Auth.signOut();
    location.href = "login.html";
  }

  function statsStrip(organisers, leagues) {
    const totalOrganisers = organisers.filter((o) => o.role === "organiser").length;
    const activeLeagues = leagues.filter((l) => l.status === "active" || l.status === "playoffs").length;
    const completedLeagues = leagues.filter((l) => l.status === "completed" || l.status === "archived").length;
    const stats = [
      ["Total organisers", totalOrganisers],
      ["Total leagues", leagues.length],
      ["Active leagues", activeLeagues],
      ["Completed leagues", completedLeagues]
    ];
    return el(
      "div",
      { class: "stats-strip" },
      stats.map(([label, value]) => el("div", { class: "stat-tile" }, [el("div", { class: "stat-value" }, String(value)), el("div", { class: "stat-label" }, label)]))
    );
  }

  // ---------- Organisers ----------

  function organisersCard(organisers, leagues) {
    const rows = organisers
      .filter((o) => o.role === "organiser")
      .map((o) => organiserRow(o, leagues));
    return el("div", { class: "card" }, [
      el("h3", {}, `Organisers (${rows.length})`),
      rows.length ? el("div", { class: "stack" }, rows) : el("p", { class: "empty-state" }, "No organisers have registered yet.")
    ]);
  }

  function organiserStatusKind(status) {
    return { pending: "amber", active: "green", suspended: "danger" }[status] || "neutral";
  }

  function organiserRow(organiser, leagues) {
    const leagueCount = leagues.filter((l) => l.organiser_id === organiser.id).length;
    const actions = [];
    if (organiser.status === "pending") {
      actions.push(el("button", { class: "btn btn-primary small", type: "button", onclick: () => setOrganiserStatus(organiser, "active") }, "Approve"));
    }
    if (organiser.status === "active") {
      actions.push(el("button", { class: "btn btn-danger small", type: "button", onclick: () => setOrganiserStatus(organiser, "suspended") }, "Suspend"));
    }
    if (organiser.status === "suspended") {
      actions.push(el("button", { class: "btn btn-ghost small", type: "button", onclick: () => setOrganiserStatus(organiser, "active") }, "Reactivate"));
    }

    return el("div", { class: "manage-row" }, [
      el("div", {}, [
        el("div", { class: "manage-row-name" }, [organiser.name, badge(organiser.status, organiserStatusKind(organiser.status))]),
        el("div", { class: "manage-row-meta" }, [
          organiser.email,
          organiser.phone ? ` · ${organiser.phone}` : "",
          ` · ${leagueCount} league${leagueCount === 1 ? "" : "s"}`,
          ` · joined ${formatDate(organiser.created_at.slice(0, 10))}`
        ].join(""))
      ]),
      el("div", { class: "row-actions" }, actions)
    ]);
  }

  async function setOrganiserStatus(organiser, status) {
    await dbUpdate("organisers", organiser.id, { status });
    render();
  }

  // ---------- Leagues ----------

  function leaguesCard(leagues, organisers) {
    const activeOrganisers = organisers.filter((o) => o.role === "organiser" && o.status === "active");
    const organisersById = Object.fromEntries(organisers.map((o) => [o.id, o]));
    const rows = leagues.map((l) => leagueRow(l, activeOrganisers, organisersById));
    return el("div", { class: "card" }, [
      el("h3", {}, `Leagues (${leagues.length})`),
      rows.length ? el("div", { class: "stack" }, rows) : el("p", { class: "empty-state" }, "No leagues yet.")
    ]);
  }

  function statusKind(status) {
    return { draft: "neutral", active: "blue", playoffs: "amber", completed: "green", archived: "neutral" }[status] || "neutral";
  }

  function leagueRow(league, activeOrganisers, organisersById) {
    const assignedOrganiser = league.organiser_id ? organisersById[league.organiser_id] : null;

    const select = el(
      "select",
      { class: "input" },
      [el("option", { value: "" }, "Unassigned"), ...activeOrganisers.map((o) => el("option", { value: o.id }, o.name))]
    );
    select.value = league.organiser_id || "";
    select.addEventListener("change", () => assignLeague(league, select.value || null));

    return el("div", { class: "manage-row" }, [
      el("div", {}, [
        el("div", { class: "manage-row-name" }, [league.name, badge(league.status, statusKind(league.status))]),
        el("div", { class: "manage-row-meta" }, [
          assignedOrganiser ? assignedOrganiser.name : "Unassigned",
          league.num_teams ? ` · ${league.num_teams} teams target` : "",
          league.start_date ? ` · starts ${formatDate(league.start_date)}` : ""
        ].join(""))
      ]),
      el("div", { class: "manage-row-assign" }, [
        el("a", { class: "btn btn-ghost small", href: `admin.html#/league/${league.id}/teams` }, "Open league"),
        select
      ])
    ]);
  }

  // Only ever PATCHes leagues.organiser_id - nothing else about the league
  // (teams/fixtures/scores/standings/settings) is touched by this call.
  async function assignLeague(league, organiserId) {
    await dbUpdate("leagues", league.id, { organiser_id: organiserId });
    render();
  }
})();
