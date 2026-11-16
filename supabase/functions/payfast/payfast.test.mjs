// Run with:  node --test supabase/functions/payfast/
// Node 24 runs the TypeScript file directly (type stripping), so this tests
// the exact code that gets deployed, with a fake database and a fake fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  phpUrlencode,
  buildParamString,
  makeSignature,
  verifySignature,
  ipInRanges,
  PAYFAST_IP_RANGES,
  parseAmountToCents,
  formatAmount,
  handleRequest,
  missingSecrets,
  TEST_AMOUNT_CENTS
} from "./index.ts";

const md5 = (s) => createHash("md5").update(s).digest("hex");

// ---------- encoding + signatures ----------

test("phpUrlencode matches PHP urlencode", () => {
  assert.equal(phpUrlencode("a b"), "a+b");
  assert.equal(phpUrlencode("a@b.com"), "a%40b.com");
  assert.equal(phpUrlencode("it's (ok)! *~"), "it%27s+%28ok%29%21+%2A%7E");
  assert.equal(phpUrlencode("a/b?c=d&e"), "a%2Fb%3Fc%3Dd%26e");
  assert.equal(phpUrlencode("keep-_."), "keep-_.");
  assert.equal(phpUrlencode("é"), "%C3%A9");
});

test("buildParamString trims values and can skip empty fields", () => {
  const pairs = [["a", " 1 "], ["b", ""], ["c", "x y"]];
  assert.equal(buildParamString(pairs, true), "a=1&c=x+y");
  assert.equal(buildParamString(pairs, false), "a=1&b=&c=x+y");
});

test("makeSignature = md5 of ordered params + passphrase", () => {
  const pairs = [
    ["merchant_id", "10000100"],
    ["merchant_key", "46f0cd694581a"],
    ["amount", "10.00"],
    ["item_name", "Test item"]
  ];
  const expected = md5("merchant_id=10000100&merchant_key=46f0cd694581a&amount=10.00&item_name=Test+item&passphrase=jt7NOE43FZPn");
  assert.equal(makeSignature(pairs, "jt7NOE43FZPn"), expected);
});

test("makeSignature drops blank fields but order matters", () => {
  const a = makeSignature([["x", "1"], ["y", ""], ["z", "2"]], "p");
  assert.equal(a, md5("x=1&z=2&passphrase=p"));
  const b = makeSignature([["z", "2"], ["x", "1"]], "p");
  assert.notEqual(a, b);
});

function signedItn(fields, passphrase) {
  const pairs = Object.entries(fields);
  const sig = md5(buildParamString(pairs, false) + `&passphrase=${phpUrlencode(passphrase)}`);
  return [...pairs, ["signature", sig]];
}

test("verifySignature accepts a correct ITN signature (blanks kept or dropped)", () => {
  const itn = signedItn({ m_payment_id: "abc", payment_status: "COMPLETE", amount_gross: "10.00", item_description: "" }, "secret");
  assert.equal(verifySignature(itn, "secret"), true);
  // Same fields, signature computed with blanks dropped:
  const rest = [["m_payment_id", "abc"], ["item_description", ""], ["amount_gross", "10.00"]];
  const sig = md5(buildParamString(rest, true) + "&passphrase=secret");
  assert.equal(verifySignature([...rest, ["signature", sig]], "secret"), true);
});

test("verifySignature rejects wrong passphrase, tampered field, missing signature", () => {
  const itn = signedItn({ m_payment_id: "abc", amount_gross: "10.00" }, "secret");
  assert.equal(verifySignature(itn, "other"), false);
  const tampered = itn.map(([k, v]) => (k === "amount_gross" ? [k, "1.00"] : [k, v]));
  assert.equal(verifySignature(tampered, "secret"), false);
  assert.equal(verifySignature(itn.filter(([k]) => k !== "signature"), "secret"), false);
  assert.equal(verifySignature([["signature", "short"], ["a", "b"]], "secret"), false);
});

// ---------- IPs + amounts ----------

test("ipInRanges", () => {
  assert.equal(ipInRanges("197.97.145.150", PAYFAST_IP_RANGES), true);
  assert.equal(ipInRanges("197.97.145.160", PAYFAST_IP_RANGES), false); // just past /28
  assert.equal(ipInRanges("41.74.179.200", PAYFAST_IP_RANGES), true);
  assert.equal(ipInRanges("144.126.193.139", PAYFAST_IP_RANGES), true);
  assert.equal(ipInRanges("144.126.193.140", PAYFAST_IP_RANGES), false);
  assert.equal(ipInRanges("8.8.8.8", PAYFAST_IP_RANGES), false);
  assert.equal(ipInRanges("", PAYFAST_IP_RANGES), false);
  assert.equal(ipInRanges("not-an-ip", PAYFAST_IP_RANGES), false);
});

test("amounts", () => {
  assert.equal(formatAmount(1000), "10.00");
  assert.equal(formatAmount(1999), "19.99");
  assert.equal(parseAmountToCents("10.00"), 1000);
  assert.equal(parseAmountToCents("10"), 1000);
  assert.equal(parseAmountToCents("0.10"), 10);
  assert.equal(parseAmountToCents("10.999"), null);
  assert.equal(parseAmountToCents("-1"), null);
  assert.equal(parseAmountToCents(""), null);
});

test("missingSecrets lists names only", () => {
  const env = new Map([["PAYFAST_MERCHANT_ID", "1"], ["SUPABASE_URL", "https://x.supabase.co"]]);
  const missing = missingSecrets(env);
  assert.ok(missing.includes("PAYFAST_MERCHANT_KEY"));
  assert.ok(missing.includes("PAYFAST_PASSPHRASE"));
  assert.ok(missing.includes("SITE_URL"));
  assert.ok(missing.includes("SB_SERVICE_KEY"));
  assert.ok(!missing.includes("PAYFAST_MERCHANT_ID"));
});

// ---------- handlers with fakes ----------

const CONFIG = {
  mode: "sandbox",
  merchantId: "10000100",
  merchantKey: "46f0cd694581a",
  passphrase: "secret-passphrase",
  siteUrl: "https://example.test",
  supabaseUrl: "https://proj.supabase.co",
  serviceKey: "svc"
};
const PAYMENT_ID = "11111111-2222-3333-4444-555555555555";
const PAYFAST_IP = "197.97.145.150";

function makeFakes({ validate = "VALID", owner = true, user = { id: "user-1" }, config = CONFIG } = {}) {
  const payments = new Map();
  const events = [];
  const calls = { validate: 0 };
  const db = {
    async getUser(token) {
      return token === "good-token" ? user : null;
    },
    async isOwner() {
      return owner;
    },
    async insertPayment(row) {
      payments.set(row.id, { ...row });
    },
    async getPayment(id) {
      return payments.get(id) || null;
    },
    async updatePaymentIfPending(id, patch) {
      const p = payments.get(id);
      if (!p || p.status !== "pending") return false;
      Object.assign(p, patch);
      return true;
    },
    async logEvent(row) {
      events.push(row);
    }
  };
  const fetchFake = async (url, init) => {
    calls.validate += 1;
    calls.lastUrl = String(url);
    calls.lastBody = init && init.body;
    return new Response(validate, { status: 200 });
  };
  return { deps: { config, fetch: fetchFake, db, uuid: () => PAYMENT_ID }, payments, events, calls };
}

function seedPending(fakes, amount_cents = 1000) {
  fakes.payments.set(PAYMENT_ID, { id: PAYMENT_ID, purpose: "test", status: "pending", amount_cents });
}

function itnRequest(overrides = {}, { passphrase = CONFIG.passphrase, ip = PAYFAST_IP, tamperAfterSigning } = {}) {
  const fields = {
    m_payment_id: PAYMENT_ID,
    pf_payment_id: "1089250",
    payment_status: "COMPLETE",
    item_name: "Padel League Manager test payment",
    amount_gross: "10.00",
    amount_fee: "-2.32",
    amount_net: "7.68",
    merchant_id: CONFIG.merchantId,
    ...overrides
  };
  let pairs = signedItn(fields, passphrase);
  if (tamperAfterSigning) pairs = tamperAfterSigning(pairs);
  const body = new URLSearchParams(pairs).toString();
  return new Request("https://proj.supabase.co/functions/v1/payfast/notify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body
  });
}

test("valid ITN marks the payment complete and logs it", async () => {
  const f = makeFakes();
  seedPending(f);
  const res = await handleRequest(itnRequest(), f.deps);
  assert.equal(res.status, 200);
  assert.equal(f.payments.get(PAYMENT_ID).status, "complete");
  assert.equal(f.payments.get(PAYMENT_ID).pf_payment_id, "1089250");
  assert.equal(f.events.at(-1).outcome, "accepted:complete");
  assert.equal(f.calls.validate, 1);
  assert.equal(f.calls.lastUrl, "https://sandbox.payfast.co.za/eng/query/validate");
});

test("replayed ITN after completion changes nothing", async () => {
  const f = makeFakes();
  seedPending(f);
  await handleRequest(itnRequest(), f.deps);
  const res = await handleRequest(itnRequest(), f.deps);
  assert.equal(res.status, 200);
  assert.equal(f.payments.get(PAYMENT_ID).status, "complete");
  assert.equal(f.events.at(-1).outcome, "duplicate");
});

test("a later FAILED ITN cannot undo a completed payment", async () => {
  const f = makeFakes();
  seedPending(f);
  await handleRequest(itnRequest(), f.deps);
  await handleRequest(itnRequest({ payment_status: "FAILED" }), f.deps);
  assert.equal(f.payments.get(PAYMENT_ID).status, "complete");
});

test("bad signature is rejected and the payment stays pending", async () => {
  const f = makeFakes();
  seedPending(f);
  const res = await handleRequest(itnRequest({}, { passphrase: "wrong" }), f.deps);
  assert.equal(res.status, 200);
  assert.equal(f.payments.get(PAYMENT_ID).status, "pending");
  assert.equal(f.events.at(-1).outcome, "rejected:bad_signature");
  assert.equal(f.calls.validate, 0);
});

test("a field changed after signing is rejected", async () => {
  const f = makeFakes();
  seedPending(f);
  await handleRequest(
    itnRequest({}, { tamperAfterSigning: (pairs) => pairs.map(([k, v]) => (k === "payment_status" ? [k, "COMPLETE!"] : [k, v])) }),
    f.deps
  );
  assert.equal(f.payments.get(PAYMENT_ID).status, "pending");
});

test("wrong amount is rejected", async () => {
  const f = makeFakes();
  seedPending(f, 5000);
  await handleRequest(itnRequest({ amount_gross: "10.00" }), f.deps);
  assert.equal(f.payments.get(PAYMENT_ID).status, "pending");
  assert.equal(f.events.at(-1).outcome, "rejected:amount_mismatch");
});

test("wrong merchant id is rejected", async () => {
  const f = makeFakes();
  seedPending(f);
  await handleRequest(itnRequest({ merchant_id: "99999999" }), f.deps);
  assert.equal(f.payments.get(PAYMENT_ID).status, "pending");
  assert.equal(f.events.at(-1).outcome, "rejected:wrong_merchant");
});

test("unknown payment is rejected (and logged without a payment id)", async () => {
  const f = makeFakes();
  await handleRequest(itnRequest(), f.deps);
  assert.equal(f.payments.size, 0);
  assert.equal(f.events.at(-1).outcome, "rejected:unknown_payment");
  assert.equal(f.events.at(-1).payment_id, null);
});

test("PayFast validate answering anything but VALID is rejected", async () => {
  const f = makeFakes({ validate: "INVALID" });
  seedPending(f);
  await handleRequest(itnRequest(), f.deps);
  assert.equal(f.payments.get(PAYMENT_ID).status, "pending");
  assert.equal(f.events.at(-1).outcome, "rejected:validate_failed");
});

test("CANCELLED ITN marks the payment cancelled", async () => {
  const f = makeFakes();
  seedPending(f);
  await handleRequest(itnRequest({ payment_status: "CANCELLED" }), f.deps);
  assert.equal(f.payments.get(PAYMENT_ID).status, "cancelled");
});

test("PENDING ITN is ignored (stays pending)", async () => {
  const f = makeFakes();
  seedPending(f);
  await handleRequest(itnRequest({ payment_status: "PENDING" }), f.deps);
  assert.equal(f.payments.get(PAYMENT_ID).status, "pending");
});

test("sandbox allows an ITN from an unexpected IP; live refuses it", async () => {
  const sandbox = makeFakes();
  seedPending(sandbox);
  await handleRequest(itnRequest({}, { ip: "8.8.8.8" }), sandbox.deps);
  assert.equal(sandbox.payments.get(PAYMENT_ID).status, "complete");
  assert.match(sandbox.events.at(-1).outcome, /ip_not_in_ranges/);

  const live = makeFakes({ config: { ...CONFIG, mode: "live" } });
  seedPending(live);
  await handleRequest(itnRequest({}, { ip: "8.8.8.8" }), live.deps);
  assert.equal(live.payments.get(PAYMENT_ID).status, "pending");
  assert.equal(live.events.at(-1).outcome, "rejected:bad_ip");
  assert.equal(live.calls.validate, 0);
});

test("live mode accepts an ITN from a PayFast IP and validates against the live host", async () => {
  const live = makeFakes({ config: { ...CONFIG, mode: "live" } });
  seedPending(live);
  await handleRequest(itnRequest(), live.deps);
  assert.equal(live.payments.get(PAYMENT_ID).status, "complete");
  assert.equal(live.calls.lastUrl, "https://www.payfast.co.za/eng/query/validate");
});

// ---------- /create ----------

function createRequest(token) {
  return new Request("https://proj.supabase.co/functions/v1/payfast/create", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: "{}"
  });
}

test("create without a token is 401 and makes no payment", async () => {
  const f = makeFakes();
  const res = await handleRequest(createRequest(null), f.deps);
  assert.equal(res.status, 401);
  assert.equal(f.payments.size, 0);
});

test("create with a bad token is 401", async () => {
  const f = makeFakes();
  const res = await handleRequest(createRequest("nope"), f.deps);
  assert.equal(res.status, 401);
  assert.equal(f.payments.size, 0);
});

test("create by a non-owner is 403 and makes no payment", async () => {
  const f = makeFakes({ owner: false });
  const res = await handleRequest(createRequest("good-token"), f.deps);
  assert.equal(res.status, 403);
  assert.equal(f.payments.size, 0);
});

test("create by the owner stores a fixed-amount pending payment and returns a valid signed form", async () => {
  const f = makeFakes();
  const res = await handleRequest(createRequest("good-token"), f.deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.action, "https://sandbox.payfast.co.za/eng/process");
  assert.equal(body.mode, "sandbox");
  assert.equal(body.paymentId, PAYMENT_ID);

  const stored = f.payments.get(PAYMENT_ID);
  assert.equal(stored.status, "pending");
  assert.equal(stored.purpose, "test");
  assert.equal(stored.amount_cents, TEST_AMOUNT_CENTS);
  assert.equal(stored.created_by, "user-1");

  const fields = Object.fromEntries(body.fields);
  assert.equal(fields.amount, "10.00");
  assert.equal(fields.m_payment_id, PAYMENT_ID);
  assert.equal(fields.merchant_id, CONFIG.merchantId);
  assert.equal(fields.notify_url, "https://proj.supabase.co/functions/v1/payfast/notify");
  assert.equal(fields.return_url, "https://example.test/owner.html#/payments-lab");

  // The signature must cover every field before it, in the posted order.
  const unsigned = body.fields.filter(([k]) => k !== "signature");
  assert.equal(fields.signature, makeSignature(unsigned, CONFIG.passphrase));
  assert.equal(body.fields.at(-1)[0], "signature");
});

test("the browser cannot choose the amount", async () => {
  const f = makeFakes();
  const req = new Request("https://proj.supabase.co/functions/v1/payfast/create", {
    method: "POST",
    headers: { Authorization: "Bearer good-token" },
    body: JSON.stringify({ amount: 1, amount_cents: 1 })
  });
  await handleRequest(req, f.deps);
  assert.equal(f.payments.get(PAYMENT_ID).amount_cents, TEST_AMOUNT_CENTS);
});

test("unknown routes are 404, OPTIONS is a CORS preflight", async () => {
  const f = makeFakes();
  const nf = await handleRequest(new Request("https://proj.supabase.co/functions/v1/payfast/other", { method: "POST" }), f.deps);
  assert.equal(nf.status, 404);
  const pre = await handleRequest(new Request("https://proj.supabase.co/functions/v1/payfast/create", { method: "OPTIONS" }), f.deps);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://example.test");
});
