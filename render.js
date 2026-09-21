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

  // Enter/"Next" on a mobile numeric keypad moves to the next box instead of
  // trying to submit the form early; the last box's key is left as "Done".
  function wireEnterAdvance(inputs) {
    inputs.forEach((input, i) => {
      input.setAttribute("enterkeyhint", i < inputs.length - 1 ? "next" : "done");
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const next = inputs[i + 1];
        if (next) next.focus();
        else input.blur();
      });
    });
  }

  window.Render = { el, formatDate, badge, qs, genAccessCode, formatSets, scoreGrid, scoreInput, wireEnterAdvance };
})();
