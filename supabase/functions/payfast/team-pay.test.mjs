// node --test supabase/functions/payfast/team-pay.test.mjs
// Team entry-fee payments (POST /team-pay), against a fake database.
import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, makeSignature, priceFor, sastDate, handleNotify } from "./index.ts";
import { buildParamString, phpUrlencode } from "./index.ts";
import { createHash } from "node:crypto";

const CONFIG = {
  mode: "sandbox",
  merchantId: "10058116",
  merchantKey: "key",
  passphrase: "pass phrase",
  siteUrl: "https://example.test",
  supabaseUrl: "https://proj.supabase.co",
  serviceKey: "svc"
};

function makeWorld({ league = {}, accepted = true, now = "2026-12-01T10:00:00Z", payments = [], insertFails = false, activation = null } = {}) {
  const world = {
    team: { id: "team-1", name: "Smashers", league_id: "league-1" },
    league: { id: "league-1", name: "Friday League", entry_fee_cents: 15000, payment_deadline: "2026-12-10", rules: { items: [] }, ...league },
    payments: payments.map((p) => ({ purpose: "team_entry", ...p })),
    inserted: [],
    uuids: ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"]
  };
  const db = {
    async getUser() { return null; },
    async isOwner() { return false; },
    async getTeamByCode(code) { return code === "ABC123" ? world.team : null; },
    async getLeague() { return world.league; },
    async hasAcceptance() { return accepted; },
    async getLeagueActivation() { return activation; },
    async findTeamEntryPayments() { return world.payments.map((p) => ({ ...p })); },
    async insertPayment(row) {
      if (insertFails) {
        // Simulates losing a race to another request that already inserted.
        world.payments.push({ id: "pay-other", purpose: "team_entry", status: "pending", amount_cents: row.amount_cents });
        throw new Error("duplicate key");
      }
      world.inserted.push(row);
      world.payments.push({ ...row });
    },
    async getPayment(id) { return world.payments.find((p) => p.id === id) || null; },
    async updatePaymentIfPending(id, patch) {
      const p = world.payments.find((x) => x.id === id);
      if (!p || p.status !== "pending") return false;
      Object.assign(p, patch);
      return true;
    },
    async logEvent() {}
  };
  world.deps = { config: CONFIG, fetch: async () => new Response("VALID"), db, uuid: () => world.uuids.shift(), now: () => new Date(now) };
  return world;
}

const post = (body) =>
  new Request("https://proj.supabase.co/functions/v1/payfast/team-pay", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("priceFor adds 20% and rounds to the cent", () => {
  assert.deepEqual(priceFor(15000), { fee: 15000, platform: 3000, total: 18000 });
  assert.deepEqual(priceFor(12345), { fee: 12345, platform: 2469, total: 14814 });
  assert.deepEqual(priceFor(500), { fee: 500, platform: 100, total: 600 });
});

test("sastDate is today in South Africa", () => {
  assert.equal(sastDate(new Date("2026-12-01T21:59:00Z")), "2026-12-01");
  assert.equal(sastDate(new Date("2026-12-01T22:00:00Z")), "2026-12-02");
});

test("a team gets a signed form for fee + 20%, and a pending payment is stored", async () => {
  const w = makeWorld();
  const res = await handleRequest(post({ code: "abc123" }), w.deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paymentId, "aaaaaaaa-0000-4000-8000-000000000001");
  const fields = Object.fromEntries(body.fields);
  assert.equal(fields.amount, "180.00");
  assert.equal(fields.m_payment_id, "aaaaaaaa-0000-4000-8000-000000000001");
  assert.equal(fields.return_url, "https://example.test/team/ABC123");
  assert.equal(fields.item_name, "Friday League - entry fee");
  assert.equal(fields.signature, makeSignature(body.fields.filter(([k]) => k !== "signature"), CONFIG.passphrase));

  assert.equal(w.inserted.length, 1);
  const stored = w.inserted[0];
  assert.equal(stored.purpose, "team_entry");
  assert.equal(stored.status, "pending");
  assert.equal(stored.amount_cents, 18000);
  assert.equal(stored.fee_cents, 15000);
  assert.equal(stored.platform_cents, 3000);
  assert.equal(stored.team_id, "team-1");
  assert.equal(stored.league_id, "league-1");
});

test("the browser cannot choose the price", async () => {
  const w = makeWorld();
  await handleRequest(post({ code: "ABC123", amount: 1, amount_cents: 1, fee_cents: 1 }), w.deps);
  assert.equal(w.inserted[0].amount_cents, 18000);
});

test("unknown code is 404; junk body is rejected; nothing stored", async () => {
  const w = makeWorld();
  assert.equal((await handleRequest(post({ code: "NOPE99" }), w.deps)).status, 404);
  assert.equal((await handleRequest(post({ code: "../x" }), w.deps)).status, 404);
  assert.equal((await handleRequest(post({}), w.deps)).status, 404);
  assert.equal((await handleRequest(post("not json"), w.deps)).status, 400);
  assert.equal(w.inserted.length, 0);
});

test("a free league (no fee) cannot be paid for", async () => {
  for (const fee of [null, 0]) {
    const w = makeWorld({ league: { entry_fee_cents: fee } });
    const res = await handleRequest(post({ code: "ABC123" }), w.deps);
    assert.equal(res.status, 400);
    assert.equal(w.inserted.length, 0);
  }
});

test("after the cut-off date payment is closed; the cut-off day itself is still open", async () => {
  const closed = makeWorld({ now: "2026-12-10T22:00:00Z" }); // already the 11th in SA
  const res = await handleRequest(post({ code: "ABC123" }), closed.deps);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).closed, true);
  assert.equal(closed.inserted.length, 0);

  const open = makeWorld({ now: "2026-12-10T21:00:00Z" }); // still the 10th in SA
  assert.equal((await handleRequest(post({ code: "ABC123" }), open.deps)).status, 200);
});

test("rules must be accepted before paying", async () => {
  const w = makeWorld({ accepted: false });
  const res = await handleRequest(post({ code: "ABC123" }), w.deps);
  assert.equal(res.status, 403);
  assert.equal(w.inserted.length, 0);
  // A league with no rules doesn't ask for acceptance.
  const noRules = makeWorld({ accepted: false, league: { rules: null } });
  assert.equal((await handleRequest(post({ code: "ABC123" }), noRules.deps)).status, 200);
});

test("a league that has not paid its R50 activation cannot take entry fees", async () => {
  const w = makeWorld({ activation: { paid: false } });
  const res = await handleRequest(post({ code: "ABC123" }), w.deps);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).notOpen, true);
  assert.equal(w.inserted.length, 0);
});

test("an activated league (or one that never needed activating) takes entry fees", async () => {
  for (const activation of [{ paid: true }, null]) {
    const w = makeWorld({ activation });
    assert.equal((await handleRequest(post({ code: "ABC123" }), w.deps)).status, 200);
  }
});

test("an already-paid team cannot pay twice", async () => {
  const w = makeWorld({ payments: [{ id: "p1", status: "complete", amount_cents: 18000 }] });
  const res = await handleRequest(post({ code: "ABC123" }), w.deps);
  assert.equal(res.status, 409);
  assert.equal(w.inserted.length, 0);
});

test("coming back to pay reuses the pending payment instead of creating another", async () => {
  const w = makeWorld({ payments: [{ id: "p-pending", status: "pending", amount_cents: 18000 }] });
  const res = await handleRequest(post({ code: "ABC123" }), w.deps);
  const body = await res.json();
  assert.equal(body.paymentId, "p-pending");
  assert.equal(w.inserted.length, 0);
});

test("a pending payment picks up a changed fee", async () => {
  const w = makeWorld({ league: { entry_fee_cents: 20000 }, payments: [{ id: "p-pending", status: "pending", amount_cents: 18000 }] });
  const body = await (await handleRequest(post({ code: "ABC123" }), w.deps)).json();
  assert.equal(Object.fromEntries(body.fields).amount, "240.00");
  assert.equal(w.payments[0].amount_cents, 24000);
});

test("a team whose earlier payment failed or was refunded can start a new one", async () => {
  for (const status of ["failed", "cancelled", "refunded"]) {
    const w = makeWorld({ payments: [{ id: "old", status, amount_cents: 18000 }] });
    const res = await handleRequest(post({ code: "ABC123" }), w.deps);
    assert.equal(res.status, 200, status);
    assert.equal(w.inserted.length, 1, status);
  }
});

test("losing a double-tap race reuses the other request's payment", async () => {
  const w = makeWorld({ insertFails: true });
  const body = await (await handleRequest(post({ code: "ABC123" }), w.deps)).json();
  assert.equal(body.paymentId, "pay-other");
});

test("a team payment is completed by a valid ITN for exactly the stored amount", async () => {
  const w = makeWorld();
  const created = await (await handleRequest(post({ code: "ABC123" }), w.deps)).json();
  const fields = { m_payment_id: created.paymentId, pf_payment_id: "42", payment_status: "COMPLETE", amount_gross: "180.00", merchant_id: CONFIG.merchantId };
  const pairs = Object.entries(fields);
  const sig = createHash("md5").update(buildParamString(pairs, false) + `&passphrase=${phpUrlencode(CONFIG.passphrase)}`).digest("hex");
  const itn = new Request("https://proj.supabase.co/functions/v1/payfast/notify", {
    method: "POST",
    headers: { "x-forwarded-for": "197.97.145.150" },
    body: new URLSearchParams([...pairs, ["signature", sig]]).toString()
  });
  await handleNotify(itn, w.deps);
  assert.equal(w.payments.find((p) => p.id === created.paymentId).status, "complete");
});
