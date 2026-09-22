// Thin persistence layer for Padel League Manager.
//
// When window.LEAGUE_CONFIG has real Supabase credentials, every call talks
// directly to Supabase's PostgREST API (no client library, same raw-fetch
// pattern as the sibling Americano app's live.js) - Supabase is then the one
// source of truth, shared across every team's device.
//
// When no credentials are configured, calls fall back to localStorage so the
// app is still fully clickable during local development before the Supabase
// project exists. This fallback is single-browser only and is not a
// substitute for Supabase in real multi-team use.
(function () {
  const LS_PREFIX = "pl_";

  function hasSupabase() {
    const c = window.LEAGUE_CONFIG || {};
    return !!(c.supabaseUrl && c.supabaseAnonKey);
  }

  function headers() {
    const { supabaseAnonKey } = window.LEAGUE_CONFIG;
    // On the organiser/owner pages (register/login/owner/my-leagues), auth.js
    // is loaded and may hold a signed-in session - use that user's own JWT
    // so Postgres RLS can see auth.uid() for them. admin.html/team.html
    // never load auth.js, so window.Auth is undefined there and this always
    // falls straight through to the anon key, exactly as before this
    // existed - zero behavior change for either page.
    const token = (window.Auth && window.Auth.getAccessToken()) || supabaseAnonKey;
    return {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    };
  }

  function uuid() {
    return crypto.randomUUID();
  }

  function lsRead(table) {
    try {
      return JSON.parse(localStorage.getItem(LS_PREFIX + table) || "[]");
    } catch (e) {
      return [];
    }
  }

  function lsWrite(table, rows) {
    localStorage.setItem(LS_PREFIX + table, JSON.stringify(rows));
  }

  function matchesFilter(row, filter) {
    return Object.entries(filter).every(([key, value]) => {
      // "select" and dotted keys (e.g. "fixtures.league_id") are Supabase-only
      // query shaping - a `select=*,fixtures!inner(id)` embedded-resource
      // filter for scoping a query through a foreign-key join server-side.
      // Local rows are flat, so there's no join to filter through; skip
      // these rather than treating them as "no row has this literal
      // property", which would silently return zero rows in local/offline
      // dev mode instead of the (unscoped, but non-empty) local data.
      if (key === "select" || key.includes(".")) return true;
      const raw = String(value).replace(/^eq\./, "");
      return String(row[key]) === raw;
    });
  }

  async function dbList(table, filter) {
    if (hasSupabase()) {
      const params = new URLSearchParams({ select: "*", order: "created_at.asc" });
      if (filter) Object.entries(filter).forEach(([k, v]) => params.set(k, v));
      const res = await fetch(`${window.LEAGUE_CONFIG.supabaseUrl}/rest/v1/${table}?${params}`, {
        headers: headers(),
        cache: "no-store"
      });
      if (!res.ok) throw new Error(`dbList ${table} failed: ${res.status} ${await res.text()}`);
      return res.json();
    }
    let rows = lsRead(table);
    if (filter) rows = rows.filter((r) => matchesFilter(r, filter));
    return rows;
  }

  async function dbGet(table, id) {
    if (hasSupabase()) {
      const rows = await dbList(table, { id: `eq.${id}` });
      return rows[0] || null;
    }
    return lsRead(table).find((r) => r.id === id) || null;
  }

  async function dbInsert(table, row) {
    const withId = { id: uuid(), created_at: new Date().toISOString(), ...row };
    if (hasSupabase()) {
      const res = await fetch(`${window.LEAGUE_CONFIG.supabaseUrl}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...headers(), Prefer: "return=representation" },
        body: JSON.stringify(withId)
      });
      if (!res.ok) throw new Error(`dbInsert ${table} failed: ${res.status} ${await res.text()}`);
      const saved = await res.json();
      return saved[0];
    }
    const rows = lsRead(table);
    rows.push(withId);
    lsWrite(table, rows);
    return withId;
  }

  async function dbUpdate(table, id, patch) {
    if (hasSupabase()) {
      const res = await fetch(`${window.LEAGUE_CONFIG.supabaseUrl}/rest/v1/${table}?id=eq.${id}`, {
        method: "PATCH",
        headers: { ...headers(), Prefer: "return=representation" },
        body: JSON.stringify(patch)
      });
      if (!res.ok) throw new Error(`dbUpdate ${table} failed: ${res.status} ${await res.text()}`);
      const saved = await res.json();
      return saved[0];
    }
    const rows = lsRead(table);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`dbUpdate ${table} ${id} not found`);
    rows[idx] = { ...rows[idx], ...patch };
    lsWrite(table, rows);
    return rows[idx];
  }

  async function dbDelete(table, id) {
    if (hasSupabase()) {
      const res = await fetch(`${window.LEAGUE_CONFIG.supabaseUrl}/rest/v1/${table}?id=eq.${id}`, {
        method: "DELETE",
        headers: headers()
      });
      if (!res.ok) throw new Error(`dbDelete ${table} failed: ${res.status} ${await res.text()}`);
      return;
    }
    lsWrite(table, lsRead(table).filter((r) => r.id !== id));
  }

  window.DB = { dbList, dbGet, dbInsert, dbUpdate, dbDelete, hasSupabase };
})();
