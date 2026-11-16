// Payments Lab (owner.html, third tab): the owner-only test harness for the
// PayFast plumbing (step 1 of pay-to-play). It can only make the fixed R10.00
// sandbox test payment - the server decides the amount, never this page - and
// lists recent payments so you can watch one go pending -> complete when
// PayFast's confirmation arrives. DOM glue only; all rules live in
// supabase/functions/payfast/index.ts.
(function () {
  const { el, badge } = window.Render;
  const { dbList, dbInsert, dbUpdate } = window.DB;

  const POLL_MS = 3000;
  const POLL_TIMES = 20; // ~1 minute of watching after a payment

  let pollTimer = null;

  function functionUrl(path) {
    return `${window.LEAGUE_CONFIG.supabaseUrl}/functions/v1/payfast/${path}`;
  }

  function statusKind(status) {
    return { pending: "amber", complete: "green", failed: "danger", cancelled: "neutral" }[status] || "neutral";
  }

  function formatMoney(cents) {
    return `R${(cents / 100).toFixed(2)}`;
  }

  function formatWhen(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  async function fetchStatus() {
    try {
      const res = await fetch(functionUrl("status"), { headers: { apikey: window.LEAGUE_CONFIG.supabaseAnonKey } });
      if (!res.ok) return { error: `The payments function isn't deployed yet (HTTP ${res.status}).` };
      return await res.json();
    } catch (err) {
      return { error: "Couldn't reach the payments function. It may not be deployed yet." };
    }
  }

  // Asks the server for a signed payment form, then posts it to PayFast the
  // same way a normal "Pay now" button would (a hidden form, top-level).
  async function startTestPayment(onError) {
    const token = window.Auth.getAccessToken();
    const res = await fetch(functionUrl("create"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, apikey: window.LEAGUE_CONFIG.supabaseAnonKey, "Content-Type": "application/json" },
      body: "{}"
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      onError(body.error || `Couldn't start the payment (HTTP ${res.status}).`);
      return;
    }
    window.Render.postForm(body.action, body.fields);
  }

  // ---------- League payouts (the Owner's ledger) ----------
  // Money from team entry fees lands with you; this shows, per league, what
  // you owe the organiser. Payouts and refunds are done by hand outside the
  // app - the buttons here only record that you did them. The maths lives in
  // payments-ledger.js.

  const { formatRand } = window.EntryFee;

  async function loadLedger(box) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "card" }, [el("h3", {}, "League payouts"), el("p", { class: "muted" }, "Loading...")]));
    let leagues, teams, payments, payouts, activations;
    try {
      [leagues, teams, payments, payouts, activations] = await Promise.all([
        dbList("leagues"),
        dbList("teams"),
        dbList("payments"),
        dbList("payouts"),
        dbList("league_activation_status")
      ]);
    } catch (err) {
      console.error(err);
      box.innerHTML = "";
      box.appendChild(
        el("div", { class: "card" }, [el("h3", {}, "League payouts"), el("p", { class: "empty-state" }, "Couldn't load - has sql/migration_011_entry_fees.sql been run?")])
      );
      return;
    }

    const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
    const sections = leagues
      .filter((l) => window.EntryFee.leagueHasFee(l) || payments.some((p) => p.league_id === l.id && p.purpose === "team_entry"))
      .map((league) =>
        leagueSection(
          league,
          payments.filter((p) => p.league_id === league.id),
          payouts.filter((p) => p.league_id === league.id),
          teamsById,
          () => loadLedger(box)
        )
      );

    // The R50 league activation fees: all yours (nothing to pay out).
    const activationPayments = payments.filter((p) => p.purpose === "league_activation" && p.status === "complete");
    const awaitingActivation = activations.filter((a) => !a.paid).length;

    box.innerHTML = "";
    box.appendChild(
      el("div", { class: "card" }, [
        el("h3", {}, "League activation fees"),
        el("div", { class: "ledger-grid" }, [
          tile("Leagues activated", String(activationPayments.length)),
          tile("Collected", formatRand(activationPayments.reduce((total, p) => total + p.amount_cents, 0))),
          tile("Waiting to pay", String(awaitingActivation))
        ])
      ])
    );
    box.appendChild(
      el("div", { class: "card" }, [
        el("h3", {}, "League payouts"),
        el(
          "p",
          { class: "muted small" },
          "Teams' entry fees are paid to you through PayFast. \"Still to pay organiser\" is the organiser's share of every paid team (plus the full amount of any refunded team, which you repay them). Record a payout here after you've paid the organiser."
        ),
        sections.length ? el("div", { class: "stack" }, sections) : el("p", { class: "empty-state" }, "No leagues with an entry fee yet.")
      ])
    );
  }

  function tile(label, value) {
    return el("div", { class: "stat-tile" }, [el("div", { class: "stat-value" }, value), el("div", { class: "stat-label" }, label)]);
  }

  function leagueSection(league, payments, payouts, teamsById, reload) {
    const ledger = window.PaymentsLedger.leagueLedger(payments, payouts);
    const entries = payments.filter((p) => p.purpose === "team_entry" && (p.status === "complete" || p.status === "refunded"));

    const rows = entries.map((p) => {
      const team = teamsById[p.team_id];
      const actions = [];
      if (p.status === "complete") {
        actions.push(
          el(
            "button",
            {
              class: "btn btn-ghost small",
              type: "button",
              onclick: async () => {
                const name = team ? team.name : "this team";
                if (!confirm(`Mark ${name}'s ${formatRand(p.amount_cents)} payment as refunded?\n\nDo this once the organiser has refunded the team. You will then owe the organiser the full ${formatRand(p.amount_cents)} back.`)) return;
                await dbUpdate("payments", p.id, { status: "refunded" });
                reload();
              }
            },
            "Mark refunded"
          )
        );
      }
      return el("div", { class: "manage-row" }, [
        el("div", {}, [
          el("div", { class: "manage-row-name" }, [team ? team.name : "Team removed", badge(p.status, p.status === "complete" ? "green" : "neutral")]),
          el("div", { class: "manage-row-meta" }, `${formatRand(p.amount_cents)} · ${formatWhen(p.created_at)}${p.pf_payment_id ? ` · PayFast #${p.pf_payment_id}` : ""}`)
        ]),
        el("div", { class: "row-actions" }, actions)
      ]);
    });

    const amountInput = el("input", { class: "input", inputmode: "decimal", placeholder: "Amount paid (R)" });
    const noteInput = el("input", { class: "input", placeholder: "Note (optional), e.g. EFT reference" });
    const error = el("p", { class: "form-error", hidden: true });
    // display:none (not the hidden attribute): .stack's own display rule would win.
    const form = el("div", { class: "stack", style: "display:none" }, [
      el("div", { class: "field-row" }, [amountInput, noteInput]),
      error,
      el(
        "button",
        {
          class: "btn btn-primary small",
          type: "button",
          onclick: async () => {
            const cents = window.EntryFee.parseRand(amountInput.value);
            if (!cents || cents <= 0) {
              error.hidden = false;
              error.textContent = "Enter the amount you paid the organiser.";
              return;
            }
            await dbInsert("payouts", { league_id: league.id, amount_cents: cents, note: noteInput.value.trim() || null });
            reload();
          }
        },
        "Save payout"
      )
    ]);
    const payoutBtn = el(
      "button",
      {
        class: "btn btn-primary small",
        type: "button",
        onclick: () => {
          const opening = form.style.display === "none";
          form.style.display = opening ? "flex" : "none";
          if (opening && ledger.owedToOrganiser > 0) amountInput.value = (ledger.owedToOrganiser / 100).toFixed(2);
        }
      },
      "Record a payout"
    );

    return el("div", { class: "card" }, [
      el("h3", {}, league.name),
      el(
        "p",
        { class: "muted small" },
        window.EntryFee.leagueHasFee(league)
          ? `Fee ${formatRand(league.entry_fee_cents)} + 20% = ${formatRand(window.EntryFee.priceFor(league.entry_fee_cents).total)} per team${league.payment_deadline ? ` · pay by ${window.Render.formatDate(league.payment_deadline)}` : ""}`
          : "No entry fee set now"
      ),
      el("div", { class: "ledger-grid" }, [
        tile("Teams paid", String(ledger.teamsPaid)),
        tile("Collected", formatRand(ledger.collected)),
        tile("Organiser share", formatRand(ledger.organiserShare)),
        tile("Your 20%", formatRand(ledger.platformShare)),
        tile("Refunded", `${ledger.teamsRefunded} · ${formatRand(ledger.refundedAmount)}`),
        tile("Paid out so far", formatRand(ledger.paidOut))
      ]),
      el("div", {}, [
        el("div", { class: "stat-label" }, "Still to pay organiser"),
        el("div", { class: "ledger-owed" }, formatRand(ledger.owedToOrganiser)),
        ledger.owedToOrganiser < 0 ? el("p", { class: "muted small" }, "You have paid the organiser more than they are owed (for example, a refund was marked after a payout).") : null,
        ledger.teamsPending ? el("p", { class: "muted small" }, `${ledger.teamsPending} payment${ledger.teamsPending === 1 ? "" : "s"} still pending with PayFast.`) : null
      ]),
      el("div", { class: "row-actions" }, [payoutBtn]),
      form,
      rows.length ? el("div", { class: "stack" }, rows) : null
    ]);
  }

  function mount(container) {
    if (pollTimer) clearInterval(pollTimer);
    container.innerHTML = "";

    const ledgerBox = el("div", {}, []);
    container.appendChild(ledgerBox);
    loadLedger(ledgerBox);

    const banner = el("div", { class: "card" }, [el("p", { class: "muted" }, "Checking the payments function...")]);
    const message = el("p", { class: "muted" }, "");
    const payBtn = el("button", { class: "btn btn-primary", type: "button", disabled: true }, "Pay R10 (test)");
    const listBox = el("div", {}, []);

    container.appendChild(
      el("div", { class: "card" }, [
        el("h3", {}, "Payment test"),
        el("p", { class: "muted" }, "Owner-only test harness for PayFast. Makes a fixed R10.00 sandbox payment - no real money, no league or team is touched."),
        banner,
        el("div", { class: "row-actions" }, [payBtn]),
        message
      ])
    );
    container.appendChild(el("div", { class: "card" }, [el("h3", {}, "Recent payments"), listBox]));

    function setMessage(text) {
      message.textContent = text;
    }

    payBtn.addEventListener("click", async () => {
      payBtn.disabled = true;
      setMessage("Starting payment...");
      try {
        await startTestPayment((text) => {
          setMessage(text);
          payBtn.disabled = false;
        });
      } catch (err) {
        setMessage("Something went wrong starting the payment.");
        payBtn.disabled = false;
      }
    });

    async function refreshList() {
      let rows;
      try {
        rows = await dbList("payments");
      } catch (err) {
        listBox.innerHTML = "";
        listBox.appendChild(el("p", { class: "empty-state" }, "Couldn't load payments - has sql/migration_010_payments.sql been run?"));
        return null;
      }
      rows = rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 15);
      listBox.innerHTML = "";
      if (!rows.length) {
        listBox.appendChild(el("p", { class: "empty-state" }, "No payments yet."));
      } else {
        listBox.appendChild(
          el(
            "div",
            { class: "stack" },
            rows.map((p) =>
              el("div", { class: "manage-row" }, [
                el("div", {}, [
                  el("div", { class: "manage-row-name" }, [`${formatMoney(p.amount_cents)} · ${p.purpose}`, badge(p.status, statusKind(p.status))]),
                  el("div", { class: "manage-row-meta" }, `${formatWhen(p.created_at)}${p.pf_payment_id ? ` · PayFast #${p.pf_payment_id}` : ""}`)
                ])
              ])
            )
          )
        );
      }
      return rows;
    }

    async function init() {
      const status = await fetchStatus();
      banner.innerHTML = "";
      if (status.error) {
        banner.appendChild(el("p", {}, [badge("not ready", "danger"), ` ${status.error} See supabase/functions/payfast/README.md.`]));
      } else if (!status.configured) {
        banner.appendChild(el("p", {}, [badge("not ready", "danger"), ` Missing secrets: ${status.missing.join(", ")}`]));
      } else {
        banner.appendChild(el("p", {}, [badge(status.mode.toUpperCase(), status.mode === "live" ? "danger" : "amber"), status.mode === "live" ? " Live mode - real money." : " Sandbox mode - no real money."]));
        payBtn.disabled = false;
      }

      const rows = await refreshList();
      // After coming back from PayFast, keep checking for a short while so
      // the pending -> complete change shows up without a manual refresh.
      if (rows && rows.some((p) => p.status === "pending")) {
        let left = POLL_TIMES;
        pollTimer = setInterval(async () => {
          left -= 1;
          const latest = await refreshList();
          if (left <= 0 || !latest || !latest.some((p) => p.status === "pending")) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        }, POLL_MS);
      }
    }

    init();
  }

  window.PaymentsLab = { mount };
})();
