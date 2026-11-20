// Club home (club.html / demo-club.html): a club's own front door.
//
// A club (see sql/migration_014_clubs.sql) subscribes monthly and runs as
// many leagues and events as it likes. Its people open the club's own link,
// e.g. padelleaguemanager.co.za/club/padel-up, sign in, and land on:
//   - "What are we playing today?"  League / Americano / Mexicano / Day event
//   - Running now                    everything still in progress
//   - Finished                       past leagues and events
//   - Club team (admins only)        who can run things here
//
// Leagues are still run in the existing league console (admin.html); this
// page only lists them and starts new ones. It tells admin.html which club a
// new league belongs to, and where "back" goes, through sessionStorage.
//
// Demo mode (demo-club.html, demo-config.js): a pretend "Padel Up" club that
// lives only in this browser. Instead of a password you pick who to sign in
// as (Brands, the club admin, or Jerosha, staff).
(function () {
  const { el, formatDate, badge, icon } = window.Render;
  const { dbList, dbGet, dbInsert, dbDelete } = window.DB;

  const DEMO = !!(window.LEAGUE_CONFIG && window.LEAGUE_CONFIG.demo);
  const KEY = DEMO ? "pl_demo_" : "pl_";
  const app = document.getElementById("app");
  const header = document.querySelector(".club-header");

  // ---------- demo data ----------

  const DEMO_CLUB = { id: "demo-club", slug: "padel-up", name: "Padel Up", status: "active" };
  const DEMO_PEOPLE = [
    { id: "demo-brands", name: "Brands", email: "brands@padelup.example", role: "admin" },
    { id: "demo-jerosha", name: "Jerosha", email: "jerosha@padelup.example", role: "staff" }
  ];

  function lsRead(table) {
    try {
      return JSON.parse(localStorage.getItem(KEY + table) || "[]");
    } catch (e) {
      return [];
    }
  }
  function lsWrite(table, rows) {
    localStorage.setItem(KEY + table, JSON.stringify(rows));
  }

  // demo.js has already created the practice league; this adds the club
  // around it (once) and puts the league in the club.
  function seedDemoClub() {
    if (!lsRead("clubs").length) {
      lsWrite("clubs", [{ ...DEMO_CLUB, created_at: new Date().toISOString() }]);
      lsWrite(
        "organisers",
        DEMO_PEOPLE.map((p) => ({ id: p.id, name: p.name, email: p.email, role: "organiser", status: "active", created_at: new Date().toISOString() }))
      );
      lsWrite(
        "club_members",
        DEMO_PEOPLE.map((p) => ({ id: `m-${p.id}`, club_id: DEMO_CLUB.id, organiser_id: p.id, role: p.role, created_at: new Date().toISOString() }))
      );
    }
    const leagues = lsRead("leagues");
    if (leagues.some((l) => !l.club_id)) lsWrite("leagues", leagues.map((l) => ({ ...l, club_id: l.club_id || DEMO_CLUB.id })));
  }

  // ---------- which club, who's signed in ----------

  function clubSlug() {
    const fromQuery = new URLSearchParams(location.search).get("c");
    if (fromQuery) return fromQuery.toLowerCase();
    const m = location.pathname.match(/\/club\/([^\/]+)\/?$/);
    if (m) return decodeURIComponent(m[1]).toLowerCase();
    return DEMO ? DEMO_CLUB.slug : null;
  }

  // The address the person came in on, so "back" in the league console
  // returns here.
  function clubHomeUrl(club) {
    return DEMO ? "demo-club.html" : `club/${club.slug}`;
  }

  function demoUserId() {
    return sessionStorage.getItem(KEY + "club_user");
  }

  async function currentPerson(club) {
    if (DEMO) {
      const id = demoUserId();
      if (!id) return null;
      const organiser = await dbGet("organisers", id);
      const [membership] = await dbList("club_members", { club_id: `eq.${club.id}`, organiser_id: `eq.${id}` });
      return organiser && membership ? { organiser, role: membership.role } : null;
    }
    const session = await window.Auth.getValidSession();
    if (!session) return null;
    const organiser = await dbGet("organisers", session.user.id);
    if (!organiser) return { organiser: null, role: null, email: session.user.email };
    if (organiser.role === "owner") return { organiser, role: "admin" };
    const [membership] = await dbList("club_members", { club_id: `eq.${club.id}`, organiser_id: `eq.${organiser.id}` });
    return { organiser, role: membership ? membership.role : null };
  }

  async function signOut() {
    if (DEMO) sessionStorage.removeItem(KEY + "club_user");
    else await window.Auth.signOut();
    render();
  }

  // ---------- page ----------

  document.addEventListener("DOMContentLoaded", render);

  async function render() {
    document.body.classList.add("theme-club");
    if (!app.hasChildNodes()) app.appendChild(window.Render.skeleton());
    try {
      if (DEMO) seedDemoClub();
      const slug = clubSlug();
      const [club] = slug ? await dbList("clubs", { slug: `eq.${slug}` }) : [];
      if (!club) return showMessage("Club not found", "Check the link you were sent - it should look like padelleaguemanager.co.za/club/your-club.");
      document.title = `${club.name} - Padel League Manager`;
      // Tidy the address to the clean club link (club.html?c=x -> /club/x).
      if (!DEMO && /club\.html$/.test(location.pathname)) history.replaceState(null, "", `/club/${club.slug}`);
      sessionStorage.setItem(KEY + "club_return", clubHomeUrl(club));
      buildHeader(club, null);

      if (club.status !== "active") {
        return showMessage(`${club.name} isn't active right now`, "The club's subscription is paused. Contact Padel League Manager to switch it back on.");
      }

      const person = await currentPerson(club);
      if (!person) return DEMO ? renderDemoPicker(club) : renderLogin(club);
      if (!person.organiser || !person.role) {
        app.innerHTML = "";
        app.appendChild(
          el("div", { class: "card club-card" }, [
            el("h2", {}, `You're not part of ${club.name} yet`),
            el("p", { class: "muted" }, `You're signed in${person.organiser ? ` as ${person.organiser.email}` : ""}, but this account hasn't been added to the club. Ask the club admin to add you, then open this link again.`),
            el("button", { class: "btn btn-ghost", type: "button", onclick: signOut }, "Sign in as someone else")
          ])
        );
        return;
      }
      if (person.organiser.status !== "active" && person.organiser.role !== "owner") {
        return showMessage("Your account is waiting for approval", "Ask the club admin to add you to the club - that switches your account on straight away.");
      }
      buildHeader(club, person);
      await renderDashboard(club, person);
    } catch (err) {
      console.error(err);
      const missing = /clubs|club_members|club_id/.test(String(err.message || ""));
      showMessage("Something went wrong", missing ? "Clubs aren't set up in the database yet (run sql/migration_014_clubs.sql)." : String(err.message || err));
    }
  }

  function showMessage(title, text) {
    app.innerHTML = "";
    app.appendChild(el("div", { class: "card club-card" }, [el("h2", {}, title), el("p", { class: "muted" }, text)]));
  }

  function initials(name) {
    return String(name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("");
  }

  function buildHeader(club, person) {
    if (!header) return;
    header.innerHTML = "";
    header.appendChild(
      el("div", { class: "club-header-inner" }, [
        el("span", { class: "club-crest" }, initials(club.name)),
        el("div", { class: "club-header-text" }, [
          el("div", { class: "club-name" }, [club.name, DEMO ? el("span", { class: "club-demo-tag" }, "Demo") : null]),
          el("div", { class: "club-powered" }, "Club hub")
        ]),
        el("span", { class: "shell-spacer" }),
        person
          ? el("button", { class: "club-user", type: "button", onclick: signOut, title: "Sign out" }, [
              el("span", { class: "avatar" }, initials(person.organiser.name)),
              el("span", { class: "club-user-name" }, "Sign out")
            ])
          : null
      ])
    );
  }

  // ---------- signing in ----------

  function renderLogin(club) {
    const email = el("input", { class: "input", type: "email", autocomplete: "email", placeholder: "you@example.com" });
    const password = el("input", { class: "input", type: "password", autocomplete: "current-password" });
    const error = el("p", { class: "form-error", hidden: true });
    const submit = el("button", { class: "btn btn-primary block", type: "submit" }, "Sign in");
    const form = el("form", { class: "card club-card club-login" }, [
      el("p", { class: "club-eyebrow" }, "Club sign-in"),
      el("h2", {}, `Welcome to ${club.name}`),
      el("p", { class: "muted" }, "Sign in to run the club's leagues, Americanos, Mexicanos and day events."),
      field("Email", email),
      window.Render.passwordField("Password", password),
      error,
      submit,
      el("p", { class: "muted small" }, ["New to the club team? ", el("a", { href: "register.html" }, "Create your account"), ", then ask the club admin to add you."])
    ]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.hidden = true;
      if (!email.value.trim() || !password.value) {
        error.hidden = false;
        error.textContent = "Email and password are required.";
        return;
      }
      submit.disabled = true;
      submit.textContent = "Signing in...";
      try {
        await window.Auth.signIn(email.value.trim(), password.value);
        render();
      } catch (err) {
        submit.disabled = false;
        submit.textContent = "Sign in";
        error.hidden = false;
        error.textContent = err.message || "Couldn't sign in - please try again.";
      }
    });
    app.innerHTML = "";
    app.appendChild(form);
  }

  async function renderDemoPicker(club) {
    const members = await dbList("club_members", { club_id: `eq.${club.id}` });
    const people = await Promise.all(members.map(async (m) => ({ m, o: await dbGet("organisers", m.organiser_id) })));
    app.innerHTML = "";
    app.appendChild(
      el("div", { class: "card club-card club-login" }, [
        el("p", { class: "club-eyebrow" }, "Club sign-in"),
        el("h2", {}, `Welcome to ${club.name}`),
        el("p", { class: "muted" }, "This is the club's own link. In the real app everyone signs in with their email and password - in the demo, just pick who you are."),
        el(
          "div",
          { class: "stack" },
          people
            .filter((p) => p.o)
            .map((p) =>
              el(
                "button",
                {
                  class: "club-person",
                  type: "button",
                  onclick: () => {
                    sessionStorage.setItem(KEY + "club_user", p.o.id);
                    render();
                  }
                },
                [
                  el("span", { class: "avatar" }, initials(p.o.name)),
                  el("span", { class: "club-person-name" }, `Sign in as ${p.o.name}`),
                  badge(p.m.role === "admin" ? "Club admin" : "Staff", p.m.role === "admin" ? "amber" : "blue")
                ]
              )
            )
        )
      ])
    );
  }

  // ---------- the dashboard ----------

  const FORMATS = [
    {
      key: "league",
      title: "League",
      icon: "trophy",
      text: "Weeks of fixtures, a log, then playoffs.",
      soon: false
    },
    {
      key: "americano",
      title: "Americano",
      icon: "users",
      text: "Swap partners every round. Everyone plays everyone.",
      soon: true,
      detail: "Add the players and courts, pick points per game, and the app draws every round so you partner each player once. Scores go in on any phone and the leaderboard updates live."
    },
    {
      key: "mexicano",
      title: "Mexicano",
      icon: "chart",
      text: "Re-paired by ranking after every round.",
      soon: true,
      detail: "Round one is random. After that the app re-ranks everyone and pairs players of similar level - so the better you do, the tougher it gets, and every game stays close."
    },
    {
      key: "day",
      title: "Day event",
      icon: "calendar",
      text: "A one-day tournament: round robin, groups or knockouts.",
      soon: true,
      detail: "Set up teams, choose round robin or groups into knockouts, best of 1 or 3 sets, and run the whole day from your phone. It stays open until the end of the next day so everyone can check the results."
    }
  ];

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
  }

  async function renderDashboard(club, person) {
    const leagues = await dbList("leagues", { club_id: `eq.${club.id}` });
    const running = leagues.filter((l) => !["completed", "archived"].includes(l.status));
    const finished = leagues.filter((l) => ["completed", "archived"].includes(l.status));

    app.innerHTML = "";
    app.appendChild(
      el("section", { class: "club-hello" }, [
        el("p", { class: "club-eyebrow" }, [person.role === "admin" ? "Club admin" : "Staff", " · ", club.name]),
        el("h2", {}, `${greeting()}, ${person.organiser.name.split(" ")[0]} 👋`),
        el("p", { class: "club-ask" }, "What are we playing today?")
      ])
    );

    app.appendChild(
      el(
        "div",
        { class: "format-grid" },
        FORMATS.map((f) =>
          el("button", { class: `format-tile format-${f.key}`, type: "button", onclick: () => startFormat(club, f) }, [
            el("span", { class: "format-icon" }, icon(f.icon, 26)),
            el("span", { class: "format-title" }, f.title),
            el("span", { class: "format-text" }, f.text),
            f.soon ? el("span", { class: "format-soon" }, "Coming soon") : null
          ])
        )
      )
    );

    app.appendChild(
      el("section", { class: "club-section" }, [
        el("div", { class: "club-section-head" }, [el("h3", {}, "Running now"), el("span", { class: "club-count" }, String(running.length))]),
        running.length
          ? el("div", { class: "stack" }, running.map((l) => eventRow(l)))
          : el("p", { class: "club-empty" }, "Nothing running. Pick something above to get going.")
      ])
    );

    if (finished.length) {
      app.appendChild(
        el("details", { class: "club-section club-finished" }, [
          el("summary", {}, [el("h3", {}, "Finished"), el("span", { class: "club-count" }, String(finished.length))]),
          el("div", { class: "stack" }, finished.map((l) => eventRow(l)))
        ])
      );
    }

    if (person.role === "admin") app.appendChild(await teamSection(club, person));
  }

  function leagueHref(league) {
    return `${DEMO ? "demo-admin.html" : "admin.html"}#/league/${league.id}/teams`;
  }

  function statusKind(status) {
    return { draft: "neutral", active: "blue", playoffs: "amber", completed: "green", archived: "neutral" }[status] || "neutral";
  }
  function statusLabel(status) {
    return { draft: "Setting up", active: "In play", playoffs: "Playoffs", completed: "Finished", archived: "Archived" }[status] || status;
  }

  function eventRow(league) {
    const bits = ["League"];
    if (league.num_teams) bits.push(`${league.num_teams} teams`);
    if (league.start_date) bits.push(`started ${formatDate(league.start_date)}`);
    return el("a", { class: "event-row", href: leagueHref(league) }, [
      el("span", { class: "event-kind kind-league" }, icon("trophy", 18)),
      el("span", { class: "event-main" }, [el("span", { class: "event-name" }, league.name), el("span", { class: "event-meta" }, bits.join(" · "))]),
      badge(statusLabel(league.status), statusKind(league.status))
    ]);
  }

  function startFormat(club, format) {
    if (format.key === "league") {
      if (DEMO) {
        // The demo has one practice league and can't create new ones.
        openSheet("League", "In the demo you run the practice league that's already set up - add teams, enter scores, simulate a week and start the playoffs. A real club creates as many leagues as it likes.", {
          label: "Open the practice league",
          href: "demo-admin.html"
        });
        return;
      }
      sessionStorage.setItem(KEY + "club_ctx", JSON.stringify({ id: club.id, name: club.name }));
      location.href = "admin.html#/new";
      return;
    }
    openSheet(`${format.title} - coming soon`, format.detail, null);
  }

  // A simple slide-up panel (phone) / centred box (desktop).
  function openSheet(title, text, action) {
    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    const overlay = el("div", { class: "club-sheet-overlay", onclick: (e) => e.target === overlay && close() }, [
      el("div", { class: "club-sheet", role: "dialog", "aria-modal": "true", "aria-label": title }, [
        el("h3", {}, title),
        el("p", { class: "muted" }, text),
        el("div", { class: "club-sheet-actions" }, [
          action ? el("a", { class: "btn btn-primary", href: action.href }, action.label) : null,
          el("button", { class: "btn btn-ghost", type: "button", onclick: close }, action ? "Not now" : "Got it")
        ])
      ])
    ]);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  }

  // ---------- club team (admins) ----------

  async function teamSection(club, person) {
    const members = await dbList("club_members", { club_id: `eq.${club.id}` });
    const ids = members.map((m) => m.organiser_id);
    const people = ids.length ? (DEMO ? lsRead("organisers").filter((o) => ids.includes(o.id)) : await dbList("organisers", { id: `in.(${ids.join(",")})` })) : [];
    const byId = Object.fromEntries(people.map((p) => [p.id, p]));

    const email = el("input", { class: "input", type: DEMO ? "text" : "email", placeholder: DEMO ? "Name, e.g. Thabo" : "Their email address" });
    const role = el("select", { class: "input club-role-select" }, [el("option", { value: "staff" }, "Staff"), el("option", { value: "admin" }, "Club admin")]);
    const error = el("p", { class: "form-error", hidden: true });
    const add = el("button", { class: "btn btn-primary", type: "submit" }, "Add");
    const form = el("form", { class: "club-add" }, [el("div", { class: "club-add-row" }, [email, role, add]), error]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.hidden = true;
      const value = email.value.trim();
      if (!value) return;
      add.disabled = true;
      try {
        if (DEMO) {
          const o = await dbInsert("organisers", { name: value, email: `${value.toLowerCase().replace(/\s+/g, ".")}@padelup.example`, role: "organiser", status: "active" });
          await dbInsert("club_members", { club_id: club.id, organiser_id: o.id, role: role.value });
        } else {
          await window.DB.dbRpc("add_club_member", { p_club_id: club.id, p_email: value, p_role: role.value });
        }
        render();
      } catch (err) {
        add.disabled = false;
        error.hidden = false;
        error.textContent = err.message || "Couldn't add them - please try again.";
      }
    });

    return el("section", { class: "club-section" }, [
      el("div", { class: "club-section-head" }, [el("h3", {}, "Club team"), el("span", { class: "club-count" }, String(members.length))]),
      el("p", { class: "club-empty" }, "Everyone here can run all of the club's leagues and events. Club admins can also add and remove people."),
      el(
        "div",
        { class: "stack" },
        members.map((m) => {
          const p = byId[m.organiser_id];
          const isMe = m.organiser_id === person.organiser.id;
          return el("div", { class: "member-row" }, [
            el("span", { class: "avatar" }, initials(p ? p.name : "?")),
            el("span", { class: "event-main" }, [el("span", { class: "event-name" }, p ? p.name + (isMe ? " (you)" : "") : "Unknown"), el("span", { class: "event-meta" }, p ? p.email : "")]),
            badge(m.role === "admin" ? "Club admin" : "Staff", m.role === "admin" ? "amber" : "blue"),
            isMe
              ? null
              : el(
                  "button",
                  {
                    class: "btn btn-subtle",
                    type: "button",
                    onclick: async () => {
                      if (!confirm(`Remove ${p ? p.name : "this person"} from ${club.name}?`)) return;
                      await dbDelete("club_members", m.id);
                      render();
                    }
                  },
                  "Remove"
                )
          ]);
        })
      ),
      el("h4", { class: "club-add-title" }, "Add someone"),
      DEMO ? null : el("p", { class: "club-empty" }, "They need to create their account first (register page), then add them here with the same email - their account is switched on straight away."),
      form
    ]);
  }

  function field(label, input) {
    return el("label", { class: "field" }, [el("span", {}, label), input]);
  }
})();
