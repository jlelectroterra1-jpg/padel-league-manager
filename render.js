// Small shared DOM helpers, kept separate from any league/scheduling logic.
(function () {
  function el(tag, attrs, children) {
    attrs = attrs || {};
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2), value);
      } else {
        node.setAttribute(key, value === true ? "" : value);
      }
    });
    (Array.isArray(children) ? children : children !== undefined ? [children] : []).forEach((child) => {
      if (child === undefined || child === null || child === false) return;
      node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function formatDate(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function badge(text, kind) {
    return el("span", { class: `badge badge-${kind || "neutral"}` }, text);
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  function genAccessCode(len) {
    len = len || 6;
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
    let out = "";
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  // "6-4, 3-6, 6-2" from a result's 3 set score columns. Pass swapTeams=true
  // to show team2's score first each set (e.g. so a team viewing their own
  // dashboard sees "my score - opponent score" regardless of which side of
  // the fixture they were stored as).
  function formatSets(result, swapTeams) {
    return [1, 2, 3]
      .map((n) => {
        const a = result[`set${n}_team1_score`];
        const b = result[`set${n}_team2_score`];
        return swapTeams ? `${b}-${a}` : `${a}-${b}`;
      })
      .join(", ");
  }

  // Compact 3-set score entry, shared verbatim between the team-facing
  // "Submit result" form (team-view.js) and the admin "Enter/Correct score"
  // form (admin.js), so the two never drift back into separate designs.
  // Layout: an empty corner cell, S1/S2/S3 headers, then one row per team
  // (whatever cell content the caller passes - a team+players block on
  // both sides) with its 3 score inputs alongside. See .score-grid in
  // style.css.
  function scoreGrid(team1Cell, team1Inputs, team2Cell, team2Inputs) {
    return el("div", { class: "score-grid" }, [
      el("div", { class: "score-grid-label" }),
      el("div", { class: "score-grid-head" }, "S1"),
      el("div", { class: "score-grid-head" }, "S2"),
      el("div", { class: "score-grid-head" }, "S3"),
      el("div", { class: "score-grid-team" }, team1Cell),
      ...team1Inputs,
      el("div", { class: "score-grid-team" }, team2Cell),
      ...team2Inputs
    ]);
  }

  function scoreInput() {
    return el("input", { class: "input score-input", type: "number", min: "0", inputmode: "numeric" });
  }

  // Advances focus through `inputs` in the given order (pass whatever
  // sequence makes sense - e.g. interleaved "your team set 1, their team
  // set 1, your team set 2, ..." rather than the DOM/visual order) two ways:
  // pressing Enter/"Next" on a mobile numeric keypad advances immediately,
  // and simply pausing after typing a value advances automatically after a
  // short delay - long enough that a two-digit score (e.g. "10") can still
  // be typed in full before it fires. The delay resets on every keystroke
  // and is cancelled if the player taps away to a different box themselves,
  // so it never steals focus from somewhere they've already moved to.
  const AUTO_ADVANCE_DELAY = 450;
  function wireAutoAdvance(inputs) {
    inputs.forEach((input, i) => {
      input.setAttribute("enterkeyhint", i < inputs.length - 1 ? "next" : "done");
      let timer = null;
      const advance = () => {
        clearTimeout(timer);
        const next = inputs[i + 1];
        if (next) next.focus();
        else input.blur();
      };
      input.addEventListener("input", () => {
        clearTimeout(timer);
        if (input.value === "") return;
        timer = setTimeout(advance, AUTO_ADVANCE_DELAY);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        advance();
      });
      input.addEventListener("blur", () => clearTimeout(timer));
    });
  }

  // A league's final rules as a numbered list - shared by admin.js (locked
  // view in Settings) and team-view.js (the accept screen and the "League
  // rules" card), so both always show rules the same way. `items` is the
  // [{ key, locked, text }] list stored on leagues.rules / an acceptance.
  function rulesList(items) {
    return el(
      "ol",
      { class: "rules-list" },
      items.map((item) => el("li", {}, item.text))
    );
  }

  // A tab bar that scrolls sideways on a phone: slide the current tab to the
  // middle so you can see where you are. (Scrolls only the bar, never the page.)
  function revealActiveTab(tabs) {
    if (!tabs) return;
    const active = tabs.querySelector(".active");
    if (!active) return;
    tabs.scrollLeft = Math.max(0, active.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2);
  }

  // Small line icons (24x24 grid, drawn with the current text colour), so the
  // interface can use pictures without any image files or libraries.
  const ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
    alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4M12 17.4v.1"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.1"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>'
  };

  function icon(name, size) {
    size = size || 22;
    return el("span", {
      class: "icon",
      "aria-hidden": "true",
      html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`
    });
  }

  // A calm placeholder shown while a page loads, instead of the word "Loading".
  function skeleton() {
    return el("div", { class: "skeleton-page", "aria-busy": "true", "aria-label": "Loading" }, [
      el("div", { class: "skeleton skeleton-hero" }),
      el("div", { class: "skeleton skeleton-line" }),
      el("div", { class: "skeleton skeleton-line short" }),
      el("div", { class: "skeleton skeleton-block" })
    ]);
  }

  // Friendly "nothing here yet": an icon, one line, and optionally what to do next.
  function emptyState(iconName, text, action) {
    return el("div", { class: "empty-card" }, [icon(iconName, 28), el("p", {}, text), action || null]);
  }

  // Sends the browser to a payment page by posting a hidden form to it - how
  // PayFast expects a payment to be started. `fields` is [[name, value], ...]
  // in the order the server signed them.
  function postForm(action, fields) {
    const form = el(
      "form",
      { method: "post", action, style: "display:none" },
      fields.map(([name, value]) => el("input", { type: "hidden", name, value }))
    );
    document.body.appendChild(form);
    form.submit();
  }

  window.Render = { el, formatDate, badge, qs, genAccessCode, formatSets, scoreGrid, scoreInput, wireAutoAdvance, rulesList, postForm, icon, skeleton, emptyState, revealActiveTab };
})();
