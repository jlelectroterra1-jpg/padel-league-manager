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

  window.Render = { el, formatDate, badge, qs, genAccessCode, formatSets };
})();
