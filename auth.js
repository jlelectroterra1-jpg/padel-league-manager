// Thin Supabase Auth (GoTrue) client for the Owner/Organiser pages
// (register.html, login.html, owner.html, my-leagues.html) only. Hand-rolled
// fetch calls against /auth/v1/*, same raw-REST philosophy as db.js's own
// PostgREST wrapper - no supabase-js client library. admin.html and
// team.html never load this file, so window.Auth is always undefined there
// and db.js's headers() always falls back to the plain anon key for them.
(function () {
  const SESSION_KEY = "pl_auth_session";

  function url() {
    return window.LEAGUE_CONFIG.supabaseUrl;
  }

  function authHeaders() {
    const { supabaseAnonKey } = window.LEAGUE_CONFIG;
    return { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}`, "Content-Type": "application/json" };
  }

  function errorMessage(body, fallback) {
    return (body && (body.msg || body.error_description || body.error || body.message)) || fallback;
  }

  function saveSession(raw) {
    const session = {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expires_at: Date.now() + (raw.expires_in || 3600) * 1000,
      user: raw.user
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function getAccessToken() {
    const session = getSession();
    return session ? session.access_token : null;
  }

  // GoTrue's own /signup response shape varies by project setting: with
  // email confirmation OFF it returns the session fields directly (or
  // nested under `session`, on newer versions); with it ON there's no
  // session at all yet, just the created user - the caller has to handle
  // both ("show a pending notice" vs "check your email") explicitly.
  async function signUp(email, password, metadata) {
    const res = await fetch(`${url()}/auth/v1/signup`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email, password, data: metadata || {} })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorMessage(body, "Sign up failed."));
    const raw = body.session || (body.access_token ? body : null);
    const session = raw ? saveSession(raw) : null;
    return { user: body.user || (session && session.user) || body, session };
  }

  async function signIn(email, password) {
    const res = await fetch(`${url()}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email, password })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorMessage(body, "Incorrect email or password."));
    return saveSession(body);
  }

  async function refreshSession(refreshToken) {
    const res = await fetch(`${url()}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body ? saveSession(body) : null;
  }

  async function signOut() {
    const session = getSession();
    if (session) {
      fetch(`${url()}/auth/v1/logout`, {
        method: "POST",
        headers: { ...authHeaders(), Authorization: `Bearer ${session.access_token}` }
      }).catch(() => {});
    }
    clearSession();
  }

  // Returns the current session, transparently refreshing it once if it's
  // expired (or close to it). Clears storage and returns null if there's no
  // session, or the refresh itself fails (e.g. the refresh token was
  // revoked) - callers treat null as "not signed in".
  async function getValidSession() {
    const session = getSession();
    if (!session) return null;
    if (session.expires_at && Date.now() < session.expires_at - 10000) return session;
    const refreshed = await refreshSession(session.refresh_token);
    if (!refreshed) {
      clearSession();
      return null;
    }
    return refreshed;
  }

  // Page guard used by owner.html/my-leagues.html: resolves the current
  // session, loads the caller's own `organisers` profile row, and redirects
  // away if anything doesn't match - to login.html if there's no valid
  // session or no profile at all, or to the visitor's OWN correct dashboard
  // if they're signed in but on the wrong page (e.g. an organiser hitting
  // owner.html directly). Returns the organiser row on success so the
  // caller doesn't have to fetch it again.
  async function requireRole(roles, opts) {
    opts = opts || {};
    const session = await getValidSession();
    if (!session) {
      location.href = "login.html";
      return null;
    }
    const organiser = await window.DB.dbGet("organisers", session.user.id);
    if (!organiser) {
      location.href = "login.html";
      return null;
    }
    if (opts.mustBeActive && organiser.status !== "active") {
      location.href = "login.html";
      return null;
    }
    if (!roles.includes(organiser.role)) {
      location.href = organiser.role === "owner" ? "owner.html" : "my-leagues.html";
      return null;
    }
    return organiser;
  }

  // Shared "your account isn't usable yet" card - reused as-is by
  // login-view.js and register-view.js so the two messages can't drift.
  function renderStatusNotice(status) {
    const { el } = window.Render;
    const copy = {
      pending: "Your organiser account is waiting on approval from the league owner. You'll be able to sign in once it's approved.",
      suspended: "Your organiser account has been suspended. Contact the league owner if you think this is a mistake."
    };
    return el("div", { class: "card notice notice-warn" }, [
      el("h3", {}, status === "pending" ? "Pending approval" : "Account suspended"),
      el("p", { class: "muted" }, copy[status] || "")
    ]);
  }

  window.Auth = {
    signUp,
    signIn,
    signOut,
    getSession,
    getAccessToken,
    getValidSession,
    requireRole,
    renderStatusNotice
  };
})();
