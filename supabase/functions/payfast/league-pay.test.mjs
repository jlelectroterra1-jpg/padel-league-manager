// node --test supabase/functions/payfast/league-pay.test.mjs
// An organiser paying the R50 to activate their league (POST /league-pay).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleRequest, handleNotify, makeSignature, buildParamString, phpUrlencode, LEAGUE_ACTIVATION_CENTS } from "./index.ts";

const CONFIG = {
  mode: "sandbox",
  merchantId: "10058116",
  merchantKey: "key",
  passphrase: "pass phrase",
  siteUrl: "https://example.test",
  supabaseUrl: "https://proj.supabase.co",
  serviceKey: "svc"
};
const LEAGUE_ID = "11111111-2222-3333-4444-555555555555";

function makeWorld({ user = { id: "org-1" }, owner = false, admin = true, activation = { paid: false }, payments = [], insertFails = false } = {}) {
  const world = {
    payments: payments.map((p) => ({ purpose: "league_activation", ...p })),
    inserted: [],
    uuids: ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"]
  };
  const db = {
    async getUser(token) { return token === "good" ? user : null; },
    async isOwner() { return owner; },
    async isLeagueAdmin(userId, leagueId) { return admin && leagueId === LEAGUE_ID; },
    async getLeague(id) { return id === LEAGUE_ID ? { id, name: "Friday League", entry_fee_cents: null, payment_deadline: null, rules: null } : null; },
    async getLeagueActivation() { return activation; },
    async findLeagueActivationPayments() { return world.payments.map((p) => ({ ...p })); },
    async insertPayment(row) {
      if (insertFails) {
        world.payments.push({ id: "pay-other", purpose: "league_activation", status: "pending", amount_cents: row.amount_cents });
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
  world.deps = { config: CONFIG, fetch: async () => new Response("VALID"), db, uuid: () => world.uuids.shift(), now: () => new Date("2026-12-01T10:00:00Z") };
  return world;
}

const post = (body, token = "good") =>
  new Request("https://proj.supabase.co/functions/v1/payfast/league-pay", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

function itnFor(paymentId, amount) {
  const fields = { m_payment_id: paymentId, pf_payment_id: "77", payment_status: "COMPLETE", amount_gross: amount, merchant_id: CONFIG.merchantId };
  const pairs = Object.entries(fields);
  const sig = createHash("md5").update(buildParamString(pairs, false) + `&passphrase=${phpUrlencode(CONFIG.passphrase)}`).digest("hex");
  return new Request("https://proj.supabase.co/functions/v1/payfast/notify", {
    method: "POST",
    headers: { "x-forwarded-for": "197.97.145.150" },
    body: new URLSearchParams([...pairs, ["signature", sig]]).toString()
  });
}

test("the activation fee is R50.00", () => {
  assert.equal(LEAGUE_ACTIVATION_CENTS, 5000);
});

test("an organiser of the league gets a signed R50.00 form and a pending payment", async () => {
  const w = makeWorld();
  const res = await handleRequest(post({ league_id: LEAGUE_ID }), w.deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fields = Object.fromEntries(body.fields);
  assert.equal(fields.amount, "50.00");
  assert.equal(fields.m_payment_id, "aaaaaaaa-0000-4000-8000-000000000001");
  assert.equal(fields.return_url, `https://example.test/admin.html#/league/${LEAGUE_ID}/activate`);
  assert.equal(fields.item_name, "Activate league - Friday League");
  assert.equal(fields.signature, makeSignature(body.fields.filter(([k]) => k !== "signature"), CONFIG.passphrase));

  const stored = w.inserted[0];
  assert.equal(stored.purpose, "league_activation");
  assert.equal(stored.status, "pending");
  assert.equal(stored.amount_cents, 5000);
  assert.equal(stored.fee_cents, 0);
  assert.equal(stored.platform_cents, 5000);
  assert.equal(stored.league_id, LEAGUE_ID);
  assert.equal(stored.created_by, "org-1");
});

test("the browser cannot choose the amount", async () => {
  const w = makeWorld();
  await handleRequest(post({ league_id: LEAGUE_ID, amount: 1, amount_cents: 1 }), w.deps);
  assert.equal(w.inserted[0].amount_cents, 5000);
});

test("no token or a bad token is 401 and creates nothing", async () => {
  const w = makeWorld();
  assert.equal((await handleRequest(post({ league_id: LEAGUE_ID }, null), w.deps)).status, 401);
  assert.equal((await handleRequest(post({ league_id: LEAGUE_ID }, "nope"), w.deps)).status, 401);
  assert.equal(w.inserted.length, 0);
});

test("someone who isn't an organiser of the league is refused", async () => {
  const w = makeWorld({ admin: false });
  const res = await handleRequest(post({ league_id: LEAGUE_ID }), w.deps);
  assert.equal(res.status, 403);
  assert.equal(w.inserted.length, 0);
});

test("the Owner may activate any league that needs it", async () => {
  const w = makeWorld({ admin: false, owner: true });
  assert.equal((await handleRequest(post({ league_id: LEAGUE_ID }), w.deps)).status, 200);
});

test("bad league ids are 404; bad bodies 400", async () => {
  const w = makeWorld();
  assert.equal((await handleRequest(post({ league_id: "../x" }), w.deps)).status, 404);
  assert.equal((await handleRequest(post({}), w.deps)).status, 404);
  assert.equal((await handleRequest(post("junk"), w.deps)).status, 400);
  assert.equal(w.inserted.length, 0);
});

test("a league that never needed activating can't be paid for", async () => {
  const w = makeWorld({ activation: null });
  assert.equal((await handleRequest(post({ league_id: LEAGUE_ID }), w.deps)).status, 400);
  assert.equal(w.inserted.length, 0);
});

test("an already-activated league can't be paid for again", async () => {
  const w = makeWorld({ activation: { paid: true } });
  const res = await handleRequest(post({ league_id: LEAGUE_ID }), w.deps);
  assert.equal(res.status, 409);
  assert.equal(w.inserted.length, 0);
});

test("coming back to pay reuses the pending payment", async () => {
  const w = makeWorld({ payments: [{ id: "p-pending", status: "pending", amount_cents: 5000 }] });
  const body = await (await handleRequest(post({ league_id: LEAGUE_ID }), w.deps)).json();
  assert.equal(body.paymentId, "p-pending");
  assert.equal(w.inserted.length, 0);
});

test("a failed earlier attempt can be retried", async () => {
  const w = makeWorld({ payments: [{ id: "old", status: "failed", amount_cents: 5000 }] });
  assert.equal((await handleRequest(post({ league_id: LEAGUE_ID }), w.deps)).status, 200);
  assert.equal(w.inserted.length, 1);
});

test("losing a double-tap race reuses the other request's payment", async () => {
  const w = makeWorld({ insertFails: true });
  const body = await (await handleRequest(post({ league_id: LEAGUE_ID }), w.deps)).json();
  assert.equal(body.paymentId, "pay-other");
});

test("a valid ITN for exactly R50.00 completes the activation payment", async () => {
  const w = makeWorld();
  const created = await (await handleRequest(post({ league_id: LEAGUE_ID }), w.deps)).json();
  await handleNotify(itnFor(created.paymentId, "50.00"), w.deps);
  assert.equal(w.payments.find((p) => p.id === created.paymentId).status, "complete");
});

test("an ITN claiming a smaller amount does not complete it", async () => {
  const w = makeWorld();
  const created = await (await handleRequest(post({ league_id: LEAGUE_ID }), w.deps)).json();
  await handleNotify(itnFor(created.paymentId, "5.00"), w.deps);
  assert.equal(w.payments.find((p) => p.id === created.paymentId).status, "pending");
});
