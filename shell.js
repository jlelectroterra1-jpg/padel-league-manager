// The shared page frame for the organiser and owner pages (login, sign up,
// My Leagues, the admin console, the Owner dashboard): a top bar with the
// brand, the main links for whoever is signed in, and an account menu - plus
// a footer. The player's team page doesn't use this; it has its own layout.
//
// Each page ships a plain static header as a fallback; this replaces its
// contents, so the pages themselves don't need to know about accounts.
(function () {
  const { el, icon } = window.Render;
  const PROFILE_KEY = "pl_profile";

  // Links for each kind of person. `match` decides which one is highlighted
  // for the page (and #hash) currently open.
  const OWNER_LINKS = [
    { label: "Dashboard", icon: "grid", href: "owner.html#/dashboard", match: (p, h) => p === "owner.html" && h !== "#/payments-lab" && h !== "#/scorer-lab" },
    { label: "Payments", icon: "card", href: "owner.html#/payments-lab", match: (p, h) => p === "owner.html" && h === "#/payments-lab" },
    { label: "All leagues", icon: "trophy", href: "admin.html#/leagues", match: (p, h) => p === "admin.html" && !h.startsWith("#/new") }
  ];
  const ORGANISER_LINKS = [
    { label: "My leagues", icon: "trophy", href: "my-leagues.html", match: (p, h) => p === "my-leagues.html" || (p === "admin.html" && !h.startsWith("#/new")) },
    { label: "Create a league", icon: "plus", href: "admin.html#/new", match: (p, h) => p === "admin.html" && h.startsWith("#/new") }
  ];

  const pageName = () => location.pathname.split("/").pop() || "index.html";

  // The account menu currently on the page (the header is rebuilt when the
  // #hash changes, so the page-wide listeners below are added once and look
  // at whichever menu is current).
  let activeMenu = null;
  function closeMenu() {
    if (!activeMenu) return;
    activeMenu.menu.hidden = true;
    activeMenu.btn.setAttribute("aria-expanded", "false");
  }

  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  // Who is signed in: their name and role, remembered for this browser tab
  // so every page doesn't have to ask again.
  async function loadProfile() {
    if (!window.Auth || !window.DB || !window.DB.hasSupabase()) return null;
    const session = window.Auth.getSession();
    if (!session || !session.user) return null;
    try {
      const cached = JSON.parse(sessionStorage.getItem(PROFILE_KEY) || "null");
      if (cached && cached.id === session.user.id) return cached;
    } catch (e) {
      /* no cache - fetch below */
    }
    let row = null;
    try {
      row = await window.DB.dbGet("organisers", session.user.id);
    } catch (e) {
      /* fall back to what the sign-up stored */
    }
    const meta = session.user.user_metadata || {};
    const profile = { id: session.user.id, name: (row && row.name) || meta.name || session.user.email, email: session.user.email, role: row ? row.role : "organiser" };
    if (row) {
      try {
        sessionStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      } catch (e) {
        /* fine */
      }
    }
    return profile;
  }

  function cachedProfile() {
    try {
      const session = window.Auth && window.Auth.getSession && window.Auth.getSession();
      const cached = JSON.parse(sessionStorage.getItem(PROFILE_KEY) || "null");
      if (session && session.user && cached && cached.id === session.user.id) return cached;
    } catch (e) {
      /* no cache */
    }
    return null;
  }

  async function logout() {
    try {
      sessionStorage.removeItem(PROFILE_KEY);
    } catch (e) {
      /* fine */
    }
    await window.Auth.signOut();
    location.href = "login.html";
  }

  function buildHeader(header, profile, signedIn) {
    const links = profile ? (profile.role === "owner" ? OWNER_LINKS : ORGANISER_LINKS) : [];
    const p = pageName();
    const h = location.hash;
    const home = profile ? (profile.role === "owner" ? "owner.html" : "my-leagues.html") : "login.html";

    const brand = el("a", { class: "brand-link", href: home }, [
      el("img", { class: "brand-mark", src: "assets/logo-192.png?v=49", alt: "" }),
      el("span", { class: "brand-name" }, "Padel League Manager")
    ]);

    const nav = el(
      "nav",
      { class: "nav-links", "aria-label": "Main" },
      links.map((l) => el("a", { class: `nav-link${l.match(p, h) ? " active" : ""}`, href: l.href, "aria-current": l.match(p, h) ? "page" : undefined }, [icon(l.icon, 18), el("span", {}, l.label)]))
    );

    let right;
    if (profile) {
      const menu = el("div", { class: "account-menu", role: "menu", hidden: true }, [
        el("div", { class: "menu-head" }, [
          el("div", { class: "menu-name" }, profile.name),
          el("div", { class: "muted small" }, profile.email),
          el("span", { class: `badge ${profile.role === "owner" ? "badge-amber" : "badge-blue"} menu-role` }, profile.role === "owner" ? "Owner" : "Organiser")
        ]),
        ...links.map((l) => el("a", { class: "menu-item", role: "menuitem", href: l.href }, l.label)),
        el("button", { class: "menu-item menu-logout", role: "menuitem", type: "button", onclick: logout }, "Log out")
      ]);
      const btn = el("button", { class: "account-btn", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "Account menu" }, [
        el("span", { class: "avatar" }, initials(profile.name)),
        el("span", { class: "account-name" }, profile.name)
      ]);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
        btn.setAttribute("aria-expanded", String(!menu.hidden));
      });
      activeMenu = { menu, btn };
      right = el("div", { class: "account" }, [btn, menu]);
    } else if (signedIn) {
      right = el("div", { class: "account" }, [el("span", { class: "avatar avatar-loading" })]);
    } else {
      right = el("div", { class: "account-links" }, [
        el("a", { class: `nav-link${p === "login.html" ? " active" : ""}`, href: "login.html" }, "Log in"),
        el("a", { class: "btn btn-primary small", href: "register.html" }, "Sign up")
      ]);
    }

    const inner = el("div", { class: "shell-inner" }, [brand, nav, el("div", { class: "shell-spacer" }), right]);
    header.innerHTML = "";
    header.classList.add("shell");
    // The front page is laid out wider than the app pages; line the bar up with it.
    const landing = !!document.querySelector(".landing");
    header.classList.toggle("wide", landing);
    // Signed in on the organiser/owner pages: the bar becomes a navy sidebar on
    // a wide screen (CSS decides; on a phone it stays a top bar).
    document.body.classList.toggle("has-sidebar", !!profile && !landing);
    header.appendChild(inner);
  }

  function buildFooter() {
    if (document.querySelector(".app-footer")) return;
    const footer = el("footer", { class: "app-footer" }, [
      el("span", {}, `© ${new Date().getFullYear()} Padel League Manager`),
      el("span", { class: "footer-links" }, [
        el("a", { href: "terms.html" }, "Terms"),
        el("a", { href: "privacy.html" }, "Privacy"),
        el("a", { href: "index.html" }, "Home")
      ])
    ]);
    document.body.appendChild(footer);
  }

  async function init() {
    const header = document.querySelector(".app-header");
    if (!header) return;
    document.addEventListener("click", (e) => {
      if (activeMenu && !activeMenu.menu.hidden && !activeMenu.menu.contains(e.target)) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });
    const signedIn = !!(window.Auth && window.Auth.getSession && window.Auth.getSession());
    // If this browser tab already knows who is signed in, draw the real layout
    // straight away so the page doesn't jump from a top bar to a sidebar.
    const known = cachedProfile();
    buildHeader(header, known, signedIn);
    buildFooter();
    const profile = await loadProfile();
    if (profile) buildHeader(header, profile, true);
    // The highlighted link follows the page's #hash (e.g. Owner tabs).
    window.addEventListener("hashchange", () => buildHeader(header, profile, signedIn));
  }

  document.addEventListener("DOMContentLoaded", init);
  window.Shell = { logout };
})();
