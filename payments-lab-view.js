// Payments Lab (owner.html, third tab): the owner-only test harness for the
// PayFast plumbing (step 1 of pay-to-play). It can only make the fixed R10.00
// sandbox test payment - the server decides the amount, never this page - and
// lists recent payments so you can watch one go pending -> complete when
// PayFast's confirmation arrives. DOM glue only; all rules live in
// supabase/functions/payfast/index.ts.
(function () {
  const { el, badge } = window.Render;
  const { dbList } = window.DB;

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
    const form = el("form", { method: "post", action: body.action, style: "display:none" }, body.fields.map(([name, value]) => el("input", { type: "hidden", name, value })));
    document.body.appendChild(form);
    form.submit();
  }

  function mount(container) {
    if (pollTimer) clearInterval(pollTimer);
    container.innerHTML = "";

    const banner = el("div", { class: "card" }, [el("p", { class: "muted" }, "Checking the payments function...")]);
    const message = el("p", { class: "muted" }, "");
    const payBtn = el("button", { class: "btn btn-primary", type: "button", disabled: true }, "Pay R10 (test)");
    const listBox = el("div", {}, []);

    container.appendChild(
      el("div", { class: "card" }, [
        el("h3", {}, "Payments Lab"),
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
