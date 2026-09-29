// Scorer Lab (owner.html only): DOM glue around the pure scorer-engine.js.
// Fully self-contained - owns its own re-render loop into the container
// it's given, completely independent of owner-view.js's top-level
// render(). A point tap must feel instant and never touch Supabase, so it
// can't go through the page's normal fetch-then-rebuild render cycle - see
// mount() below.
(function () {
  const { el, badge } = window.Render;
  const STORAGE_KEY = "pl_scorer_lab_state";

  function loadPersisted() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function persist(match) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(match));
  }

  function clearPersisted() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // `match` here is just { teamAName, teamBName, initialServer, events } -
  // the actual scoring state is always computed fresh from `events` via
  // window.ScorerEngine.computeState, never stored separately.
  function mount(container) {
    let match = loadPersisted();

    function rerender() {
      container.innerHTML = "";
      container.appendChild(match ? liveView() : setupView());
    }

    function setupView() {
      const nameA = el("input", { class: "input", value: "My Team" });
      const nameB = el("input", { class: "input", value: "Opponent" });
      const serverChoice = el(
        "select",
        { class: "input" },
        [el("option", { value: "A" }, "My Team serves first"), el("option", { value: "B" }, "Opponent serves first")]
      );

      const form = el("form", { class: "card" }, [
        el("h3", {}, "Start a test match"),
        el("p", { class: "muted small" }, "Owner-only prototype - nothing here touches real leagues, fixtures, or results."),
        field("Team A name", nameA),
        field("Team B name", nameB),
        field("Who serves first?", serverChoice),
        el("button", { class: "btn btn-primary", type: "submit" }, "Start match")
      ]);

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        match = {
          teamAName: nameA.value.trim() || "My Team",
          teamBName: nameB.value.trim() || "Opponent",
          initialServer: serverChoice.value,
          events: []
        };
        persist(match);
        rerender();
      });

      return form;
    }

    function field(label, input) {
      return el("label", { class: "field" }, [el("span", {}, label), input]);
    }

    function addPoint(team) {
      match.events.push(team);
      persist(match);
      rerender();
    }

    function undoLastPoint() {
      match.events.pop();
      persist(match);
      rerender();
    }

    async function confirmReset() {
      const confirmed = await resetConfirmModal();
      if (!confirmed) return;
      match = null;
      clearPersisted();
      rerender();
    }

    function liveView() {
      const state = window.ScorerEngine.computeState(match.initialServer, match.events);
      const labels = window.ScorerEngine.pointLabel(state.points, state.tiebreak);
      const setNumber = state.sets.length + 1;

      const court = el("div", { class: "scorer-court" }, [
        scorerSide("A", match.teamAName, labels.A, state.games.A, state.server === "A", !!state.winner),
        scorerSide("B", match.teamBName, labels.B, state.games.B, state.server === "B", !!state.winner)
      ]);

      const header = el("div", { class: "detail-header" }, [
        el("h2", {}, state.winner ? "Match complete" : `Set ${Math.min(setNumber, 3)}${state.tiebreak ? " - Tiebreak" : ""}`)
      ]);

      const winnerBanner = state.winner
        ? el("div", { class: "card champion-card" }, [
            el("div", {}, "🏆 MATCH WON"),
            el("h2", {}, state.winner === "A" ? match.teamAName : match.teamBName)
          ])
        : null;

      const actions = el("div", { class: "row-actions" }, [
        el("button", { class: "btn btn-ghost", type: "button", disabled: !match.events.length, onclick: undoLastPoint }, "Undo last point"),
        el("button", { class: "btn btn-danger", type: "button", onclick: confirmReset }, "Reset match")
      ]);

      return el("div", { class: "stack" }, [header, winnerBanner, court, actions, matchOverview(state, match), testingPanel(state)]);
    }

    function scorerSide(team, name, pointLabel, games, isServing, matchOver) {
      return el(
        "button",
        {
          class: `scorer-side team-${team.toLowerCase()}`,
          type: "button",
          disabled: matchOver,
          onclick: () => addPoint(team)
        },
        [
          isServing ? el("div", { class: "scorer-serving" }, "🎾 SERVING") : el("div", { class: "scorer-serving" }, " "),
          el("div", { class: "scorer-team-name" }, name),
          el("div", { class: "scorer-point" }, pointLabel),
          el("div", { class: "scorer-games" }, `Games: ${games}`)
        ]
      );
    }

    function matchOverview(state, match) {
      const rows = state.sets.map((s, i) =>
        el("div", { class: "fixture-row" }, [
          el("span", { class: "court-tag" }, `Set ${i + 1}`),
          el("strong", {}, `${s.games.A}-${s.games.B}`),
          s.tiebreak ? el("span", { class: "muted small" }, `(tiebreak ${s.tiebreak.A}-${s.tiebreak.B})`) : null
        ])
      );
      if (!state.winner) {
        rows.push(
          el("div", { class: "fixture-row" }, [
            el("span", { class: "court-tag" }, `Set ${state.sets.length + 1}`),
            el("span", { class: "muted" }, "Current:"),
            el("strong", {}, `${state.games.A}-${state.games.B}`)
          ])
        );
      }
      return el("div", { class: "card" }, [
        el("h3", {}, "Match overview"),
        el("div", { class: "stack" }, rows),
        el("p", { class: "muted small" }, `Sets won: ${match.teamAName} ${state.setsWon.A} - ${state.setsWon.B} ${match.teamBName}`)
      ]);
    }

    function testingPanel(state) {
      const rows = [
        ["Current set", String(Math.min(state.sets.length + 1, 3))],
        ["Current games", `${state.games.A}-${state.games.B}`],
        ["Current points", `${state.points.A}-${state.points.B}`],
        ["Sets won", `${state.setsWon.A}-${state.setsWon.B}`],
        ["Current server", state.server === "A" ? "Team A" : "Team B"],
        ["Tiebreak active", state.tiebreak ? "Yes" : "No"],
        ["Match complete", state.winner ? "Yes" : "No"]
      ];
      return el("div", { class: "card small" }, [
        el("h3", {}, "Owner testing panel"),
        el(
          "div",
          { class: "stack" },
          rows.map(([label, value]) => el("div", { class: "field-row", style: "margin-bottom:0;" }, [el("span", { class: "muted" }, label), el("strong", {}, value)]))
        )
      ]);
    }

    // Same promise-resolves-on-button-click modal pattern used elsewhere in
    // this app (team-view.js's confirmSubmitModal, admin.js's
    // forfeitConfirmModal, owner-view.js's manage-admins panel).
    function resetConfirmModal() {
      return new Promise((resolve) => {
        const cancelBtn = el("button", { class: "btn btn-ghost small", type: "button" }, "Cancel");
        const confirmBtn = el("button", { class: "btn btn-danger small", type: "button" }, "Reset match");
        const card = el("div", { class: "card modal-card" }, [
          el("h3", {}, "Reset this match?"),
          el("p", { class: "muted" }, "This clears the current test match completely - there's no undo for a reset."),
          el("div", { class: "row-actions modal-actions" }, [cancelBtn, confirmBtn])
        ]);
        const backdrop = el("div", { class: "modal-backdrop" }, [card]);

        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";

        function close(result) {
          document.removeEventListener("keydown", onKeydown);
          document.body.style.overflow = prevOverflow;
          backdrop.remove();
          resolve(result);
        }
        function onKeydown(e) {
          if (e.key === "Escape") close(false);
        }
        cancelBtn.addEventListener("click", () => close(false));
        confirmBtn.addEventListener("click", () => close(true));
        backdrop.addEventListener("click", (e) => {
          if (e.target === backdrop) close(false);
        });
        document.addEventListener("keydown", onKeydown);

        document.body.appendChild(backdrop);
      });
    }

    rerender();
  }

  window.ScorerLab = { mount };
})();
