// Owner dashboard (owner.html): platform-wide stats, an organisers table
// (approve/suspend/reactivate), and a leagues table (open + manage admins).
// A league can now have multiple admins (see migration_007's league_admins
// junction table) - DOM glue only, reuses the existing admin.html
// league-card look/link, never rebuilds it.
(function () {
  const { el, formatDate, badge } = window.Render;
  const { dbList, dbUpdate, dbInsert, dbDelete } = window.DB;

  const app = document.getElementById("app");

  document.addEventListener("DOMContentLoaded", render);
  window.addEventListener("hashchange", render);

  // "Scorer Lab" (owner-only live scoring prototype - see scorer-engine.js/
  // scorer-lab-view.js) is a second tab here, same #/tab hash pattern
  // admin.js uses. Switching tabs re-runs this render(), but ScorerLab owns
  // its own independent re-render loop once mounted - a point tap never
  // comes back through here, so it never re-fetches organisers/leagues.
  function parseTab() {
    const hash = location.hash.replace(/^#\/?/, "");
    return hash === "scorer-lab" || hash === "payments-lab" ? hash : "dashboard";
  }

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

    const tab = parseTab();
    app.innerHTML = "";

    app.appendChild(
      el("div", { class: "detail-header" }, [
        el("h2", {}, "Owner dashboard"),
        el("button", { class: "btn btn-ghost small", type: "button", onclick: () => logout() }, "Log out")
      ])
    );
    app.appendChild(
      el("div", { class: "tabs-inline" }, [
        el("a", { class: `tab-inline ${tab === "dashboard" ? "active" : ""}`, href: "#/dashboard" }, "Dashboard"),
        el("a", { class: `tab-inline ${tab === "scorer-lab" ? "active" : ""}`, href: "#/scorer-lab" }, "Scorer Lab"),
        el("a", { class: `tab-inline ${tab === "payments-lab" ? "active" : ""}`, href: "#/payments-lab" }, "Payments")
      ])
    );

    if (tab === "scorer-lab") {
      const container = el("div", {});
      app.appendChild(container);
      window.ScorerLab.mount(container);
      return;
    }

    if (tab === "payments-lab") {
      const container = el("div", {});
      app.appendChild(container);
      window.PaymentsLab.mount(container);
      return;
    }

    const [organisers, leagues, leagueAdmins, activations] = await Promise.all([
      dbList("organisers"),
      dbList("leagues"),
      dbList("league_admins"),
      dbList("league_activation_status")
    ]);
    // Leagues an organiser created that haven't paid their R50 yet.
    const unpaidLeagueIds = new Set(activations.filter((a) => !a.paid).map((a) => a.league_id));
    app.appendChild(statsStrip(organisers, leagues));
    app.appendChild(organisersCard(organisers, leagueAdmins));
    app.appendChild(leaguesCard(leagues, organisers, leagueAdmins, unpaidLeagueIds));
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

  function organisersCard(organisers, leagueAdmins) {
    const rows = organisers
      .filter((o) => o.role === "organiser")
      .map((o) => organiserRow(o, leagueAdmins));
    return el("div", { class: "card" }, [
      el("h3", {}, `Organisers (${rows.length})`),
      rows.length ? el("div", { class: "stack" }, rows) : el("p", { class: "empty-state" }, "No organisers have registered yet.")
    ]);
  }

  function organiserStatusKind(status) {
    return { pending: "amber", active: "green", suspended: "danger" }[status] || "neutral";
  }

  function organiserRow(organiser, leagueAdmins) {
    const leagueCount = leagueAdmins.filter((a) => a.organiser_id === organiser.id).length;
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

  function leaguesCard(leagues, organisers, leagueAdmins, unpaidLeagueIds) {
    const activeOrganisers = organisers.filter((o) => o.role === "organiser" && o.status === "active");
    const organisersById = Object.fromEntries(organisers.map((o) => [o.id, o]));
    const rows = leagues.map((l) => leagueRow(l, leagueAdmins, activeOrganisers, organisersById, unpaidLeagueIds.has(l.id)));
    return el("div", { class: "card" }, [
      el("h3", {}, `Leagues (${leagues.length})`),
      rows.length ? el("div", { class: "stack" }, rows) : el("p", { class: "empty-state" }, "No leagues yet.")
    ]);
  }

  function statusKind(status) {
    return { draft: "neutral", active: "blue", playoffs: "amber", completed: "green", archived: "neutral" }[status] || "neutral";
  }

  function leagueRow(league, leagueAdmins, activeOrganisers, organisersById, unpaid) {
    const admins = leagueAdmins
      .filter((a) => a.league_id === league.id)
      .map((a) => organisersById[a.organiser_id])
      .filter(Boolean);

    return el("div", { class: "manage-row" }, [
      el("div", {}, [
        el("div", { class: "manage-row-name" }, [league.name, badge(league.status, statusKind(league.status)), unpaid && badge("not activated", "amber")]),
        el("div", { class: "manage-row-meta" }, [
          admins.length ? `Admins: ${admins.map((o) => o.name).join(", ")}` : "Unassigned",
          league.num_teams ? ` · ${league.num_teams} teams target` : "",
          league.start_date ? ` · starts ${formatDate(league.start_date)}` : ""
        ].join(""))
      ]),
      el("div", { class: "manage-row-assign" }, [
        el(
          "button",
          { class: "btn btn-ghost small", type: "button", onclick: () => openManageAdmins(league, leagueAdmins, activeOrganisers, organisersById) },
          "Manage admins"
        ),
        el("a", { class: "btn btn-ghost small", href: `admin.html#/league/${league.id}/teams` }, "Open league")
      ])
    ]);
  }

  async function openManageAdmins(league, leagueAdmins, activeOrganisers, organisersById) {
    const current = leagueAdmins.filter((a) => a.league_id === league.id);
    await manageAdminsModal(league, current, activeOrganisers, organisersById);
    render(); // refresh admin lists/counts everywhere on the dashboard
  }

  // Stays open across multiple add/remove actions (unlike the confirm-once
  // modals elsewhere in this app - team-view.js's confirmSubmitModal,
  // admin.js's forfeitConfirmModal) - each action persists immediately and
  // re-renders just this panel's own body; only closing it hands control
  // back to the caller, which then refreshes the main dashboard.
  function manageAdminsModal(league, initialAdmins, activeOrganisers, organisersById) {
    return new Promise((resolve) => {
      let admins = initialAdmins.slice();
      const closeBtn = el("button", { class: "btn btn-ghost small", type: "button" }, "Close");
      const body = el("div", {}, []);
      const card = el("div", { class: "card modal-card" }, [el("h3", {}, `Manage admins - ${league.name}`), body, el("div", { class: "row-actions modal-actions" }, [closeBtn])]);
      const backdrop = el("div", { class: "modal-backdrop" }, [card]);

      function renderBody() {
        body.innerHTML = "";
        const adminRows = admins.length
          ? admins.map((a) => {
              const organiser = organisersById[a.organiser_id];
              return el("div", { class: "row-actions", style: "justify-content:space-between;" }, [
                el("span", {}, organiser ? organiser.name : "Unknown organiser"),
                el("button", { class: "btn btn-danger small", type: "button", onclick: () => removeAdmin(a) }, "Remove")
              ]);
            })
          : [el("p", { class: "empty-state" }, "No admins assigned yet.")];

        const assignedIds = new Set(admins.map((a) => a.organiser_id));
        const available = activeOrganisers.filter((o) => !assignedIds.has(o.id));
        const select = el(
          "select",
          { class: "input" },
          available.length ? available.map((o) => el("option", { value: o.id }, o.name)) : [el("option", { value: "" }, "No more organisers to add")]
        );
        const addBtn = el(
          "button",
          { class: "btn btn-primary small", type: "button", disabled: !available.length, onclick: () => addAdmin(select.value) },
          "+ Add admin"
        );

        body.appendChild(el("div", { class: "stack" }, [...adminRows, el("div", { class: "field-row", style: "align-items:center;" }, [select, addBtn])]));
      }

      async function addAdmin(organiserId) {
        if (!organiserId) return;
        const saved = await dbInsert("league_admins", { league_id: league.id, organiser_id: organiserId, role: "admin" });
        admins.push(saved);
        renderBody();
      }

      async function removeAdmin(admin) {
        await dbDelete("league_admins", admin.id);
        admins = admins.filter((a) => a.id !== admin.id);
        renderBody();
      }

      function close() {
        document.removeEventListener("keydown", onKeydown);
        document.body.style.overflow = prevOverflow;
        backdrop.remove();
        resolve();
      }
      function onKeydown(e) {
        if (e.key === "Escape") close();
      }
      closeBtn.addEventListener("click", close);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close();
      });
      document.addEventListener("keydown", onKeydown);

      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      renderBody();
      document.body.appendChild(backdrop);
    });
  }
})();
