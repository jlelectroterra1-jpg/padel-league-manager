// PayFast payments for Padel League Manager - a single Supabase Edge Function
// (paste this one file into the dashboard, or deploy with the CLI; see
// README.md next to it).
//
// Routes (the function is called "payfast", so they live under
// /functions/v1/payfast/...):
//   GET  /status  - is it set up, and in which mode (no secrets revealed)
//   POST /create  - Owner only (step 1): makes a test payment and returns the
//                   signed PayFast form for the browser to POST to PayFast
//   POST /notify  - PayFast's confirmation message (ITN); the ONLY thing that
//                   can ever mark a payment complete
//
// Why this is a server function at all: the price is decided here, never by
// the browser, and a payment is only believed once PayFast's confirmation
// passes every check in handleNotify - signature, source IP, amount, PayFast's
// own server-to-server validate call. Secrets (merchant key, passphrase,
// service key) live in Supabase secrets, never in the repo or the browser.
//
// All logic is in plain exported functions that take their dependencies as
// arguments (database, fetch, clock), so payfast.test.mjs can run it under
// Node with fakes - Deno.serve is wired up only at the very bottom. Keep to
// erasable TypeScript (no enums, no constructor parameter properties) so Node
// can run this file directly.
import { createHash, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

// ---------- constants ----------

export const PAYFAST_HOSTS = {
  sandbox: "https://sandbox.payfast.co.za",
  live: "https://www.payfast.co.za"
};

// PayFast's published ITN source ranges - re-check against PayFast's current
// developer docs before going live.
export const PAYFAST_IP_RANGES = [
  "197.97.145.144/28",
  "41.74.179.192/27",
  "102.216.36.0/28",
  "102.216.36.128/28",
  "144.126.193.139/32"
];

// Step 1 only ever makes this one fixed test payment (R10.00), whatever the
// browser asks for - the browser doesn't get a say in the amount at all.
export const TEST_AMOUNT_CENTS = 1000;

// ---------- types ----------

export type Pair = [string, string];

export interface Config {
  mode: "sandbox" | "live";
  merchantId: string;
  merchantKey: string;
  passphrase: string;
  siteUrl: string;
  supabaseUrl: string;
  serviceKey: string;
}

export interface PaymentRow {
  id: string;
  purpose: string;
  status: string;
  amount_cents: number;
  pf_payment_id?: string | null;
}

export interface Db {
  getUser(token: string): Promise<{ id: string } | null>;
  isOwner(userId: string): Promise<boolean>;
  insertPayment(row: Record<string, unknown>): Promise<void>;
  getPayment(id: string): Promise<PaymentRow | null>;
  // Only changes a payment that is still 'pending'; true if it changed one.
  updatePaymentIfPending(id: string, patch: Record<string, unknown>): Promise<boolean>;
  logEvent(row: { payment_id: string | null; outcome: string; payload: unknown }): Promise<void>;
}

export interface Deps {
  config: Config;
  fetch: typeof fetch;
  db: Db;
  uuid: () => string;
}

// ---------- config ----------

const REQUIRED_SECRETS = ["PAYFAST_MERCHANT_ID", "PAYFAST_MERCHANT_KEY", "PAYFAST_PASSPHRASE", "SITE_URL"];

// Names (never values) of any secret that isn't set yet - what /status shows,
// so a half-finished setup says exactly what's missing.
export function missingSecrets(env: { get(name: string): string | undefined }): string[] {
  const missing = REQUIRED_SECRETS.filter((name) => !env.get(name));
  if (!env.get("SUPABASE_URL")) missing.push("SUPABASE_URL");
  if (!env.get("SB_SERVICE_KEY") && !env.get("SUPABASE_SERVICE_ROLE_KEY")) missing.push("SB_SERVICE_KEY");
  return missing;
}

export function readConfig(env: { get(name: string): string | undefined }): Config {
  const missing = missingSecrets(env);
  if (missing.length) throw new Error(`Missing secrets: ${missing.join(", ")}`);
  const mode = env.get("PAYFAST_MODE") === "live" ? "live" : "sandbox";
  return {
    mode,
    merchantId: env.get("PAYFAST_MERCHANT_ID")!,
    merchantKey: env.get("PAYFAST_MERCHANT_KEY")!,
    passphrase: env.get("PAYFAST_PASSPHRASE")!,
    siteUrl: env.get("SITE_URL")!.replace(/\/+$/, ""),
    supabaseUrl: env.get("SUPABASE_URL")!.replace(/\/+$/, ""),
    serviceKey: (env.get("SB_SERVICE_KEY") || env.get("SUPABASE_SERVICE_ROLE_KEY"))!
  };
}

// ---------- signatures ----------

// PHP's urlencode(), which is what PayFast signs with: spaces become "+", hex
// digits are uppercase, and everything except letters, digits and -_. is
// encoded - including ! ' ( ) * ~, which encodeURIComponent would leave alone.
export function phpUrlencode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, "+");
}

// key=value&key=value in the order given. Values are trimmed. A payment form's
// signature leaves out blank fields; PayFast's sample ITN check keeps them, so
// the caller says which.
export function buildParamString(pairs: Pair[], skipEmpty: boolean): string {
  return pairs
    .filter(([, v]) => !(skipEmpty && String(v).trim() === ""))
    .map(([k, v]) => `${k}=${phpUrlencode(String(v).trim())}`)
    .join("&");
}

export function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

// The signature for a payment form we send to PayFast: fields in the exact
// order they are posted, blanks dropped, passphrase appended.
export function makeSignature(pairs: Pair[], passphrase: string): string {
  return md5(buildParamString(pairs, true) + `&passphrase=${phpUrlencode(passphrase.trim())}`);
}

// Checks an ITN's signature: every posted field except `signature`, in the
// order PayFast posted them, passphrase appended. Accepts the blanks-kept
// form (PayFast's own sample) or blanks-dropped, so a quirk in how PayFast
// treats empty fields can't lock us out - the passphrase is the secret either
// way, and the server-to-server validate call is still required after this.
export function verifySignature(pairs: Pair[], passphrase: string): boolean {
  const received = pairs.find(([k]) => k === "signature");
  if (!received) return false;
  const rest = pairs.filter(([k]) => k !== "signature");
  const suffix = `&passphrase=${phpUrlencode(passphrase.trim())}`;
  const candidates = [md5(buildParamString(rest, false) + suffix), md5(buildParamString(rest, true) + suffix)];
  const want = Buffer.from(received[1].toLowerCase());
  return candidates.some((c) => {
    const got = Buffer.from(c);
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

// ---------- IP ranges ----------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

export function ipInRanges(ip: string, ranges: string[]): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  return ranges.some((range) => {
    const [base, bitsText] = range.split("/");
    const baseInt = ipv4ToInt(base);
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (baseInt === null || !(bits >= 0 && bits <= 32)) return false;
    const size = 2 ** (32 - bits);
    return Math.floor(ipInt / size) === Math.floor(baseInt / size);
  });
}

// The address PayFast's request actually came from, as seen at the edge.
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (headers.get("cf-connecting-ip") || "").trim();
}

// ---------- amounts ----------

export function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function parseAmountToCents(text: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) return null;
  return Math.round(Number(text.trim()) * 100);
}

// ---------- HTTP helpers ----------

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extraHeaders } });
}

function corsHeaders(config: Config): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": config.siteUrl,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin"
  };
}

// ---------- routes ----------

export async function handleCreate(req: Request, deps: Deps): Promise<Response> {
  const { config, db } = deps;
  const cors = corsHeaders(config);

  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json({ error: "Sign in first." }, 401, cors);

  const user = await db.getUser(token);
  if (!user) return json({ error: "Sign in first." }, 401, cors);

  // Step 1 is a test harness: only the Owner may make a payment at all.
  if (!(await db.isOwner(user.id))) return json({ error: "Owner only." }, 403, cors);

  const paymentId = deps.uuid();
  await db.insertPayment({
    id: paymentId,
    purpose: "test",
    status: "pending",
    amount_cents: TEST_AMOUNT_CENTS,
    created_by: user.id
  });

  // The order here is the order the browser must post them, and the order the
  // signature is built from.
  const returnUrl = `${config.siteUrl}/owner.html#/payments-lab`;
  const fields: Pair[] = [
    ["merchant_id", config.merchantId],
    ["merchant_key", config.merchantKey],
    ["return_url", returnUrl],
    ["cancel_url", returnUrl],
    ["notify_url", `${config.supabaseUrl}/functions/v1/payfast/notify`],
    ["m_payment_id", paymentId],
    ["amount", formatAmount(TEST_AMOUNT_CENTS)],
    ["item_name", "Padel League Manager test payment"]
  ];
  fields.push(["signature", makeSignature(fields, config.passphrase)]);

  return json({ action: `${PAYFAST_HOSTS[config.mode]}/eng/process`, fields, paymentId, mode: config.mode }, 200, cors);
}

// PayFast's confirmation. Answers 200 to everything it can read (so PayFast
// doesn't keep retrying a message we've deliberately refused) and records the
// outcome - including every refusal - in payment_events.
export async function handleNotify(req: Request, deps: Deps): Promise<Response> {
  const { config, db } = deps;
  const body = await req.text();
  const pairs: Pair[] = [...new URLSearchParams(body).entries()];
  const data = Object.fromEntries(pairs);
  const paymentId = /^[0-9a-f-]{36}$/i.test(data.m_payment_id || "") ? data.m_payment_id : null;
  const ok = new Response("OK", { status: 200 });

  async function refuse(reason: string): Promise<Response> {
    await db.logEvent({ payment_id: paymentId && (await db.getPayment(paymentId)) ? paymentId : null, outcome: `rejected:${reason}`, payload: data });
    return ok;
  }

  if (!verifySignature(pairs, config.passphrase)) return refuse("bad_signature");

  // In live mode a notification from outside PayFast's ranges is refused. In
  // sandbox it's only noted, because sandbox traffic isn't guaranteed to come
  // from the same ranges - the signature and validate call still apply.
  const ipOk = ipInRanges(clientIp(req.headers), PAYFAST_IP_RANGES);
  if (!ipOk && config.mode === "live") return refuse("bad_ip");

  if (data.merchant_id !== config.merchantId) return refuse("wrong_merchant");
  if (!paymentId) return refuse("unknown_payment");

  const payment = await db.getPayment(paymentId);
  if (!payment) return refuse("unknown_payment");

  const cents = parseAmountToCents(data.amount_gross || "");
  if (cents === null || cents !== payment.amount_cents) return refuse("amount_mismatch");

  if (payment.status !== "pending") {
    await db.logEvent({ payment_id: paymentId, outcome: "duplicate", payload: data });
    return ok;
  }

  // PayFast's own check that this notification is genuine.
  const validateRes = await deps.fetch(`${PAYFAST_HOSTS[config.mode]}/eng/query/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const validateText = (await validateRes.text()).trim();
  if (validateText !== "VALID") return refuse("validate_failed");

  const statusMap: Record<string, string> = { COMPLETE: "complete", CANCELLED: "cancelled", FAILED: "failed" };
  const newStatus = statusMap[(data.payment_status || "").toUpperCase()];
  if (!newStatus) {
    await db.logEvent({ payment_id: paymentId, outcome: `ignored:status_${data.payment_status || "none"}`, payload: data });
    return ok;
  }

  const changed = await db.updatePaymentIfPending(paymentId, { status: newStatus, pf_payment_id: data.pf_payment_id || null });
  await db.logEvent({
    payment_id: paymentId,
    outcome: changed ? `accepted:${newStatus}${ipOk ? "" : ":ip_not_in_ranges"}` : "duplicate",
    payload: data
  });
  return ok;
}

export async function handleStatus(env: { get(name: string): string | undefined }): Promise<Response> {
  const missing = missingSecrets(env);
  const mode = env.get("PAYFAST_MODE") === "live" ? "live" : "sandbox";
  return json({ configured: missing.length === 0, missing, mode }, 200, {
    "Access-Control-Allow-Origin": env.get("SITE_URL") || "*"
  });
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(deps.config) });
  if (path.endsWith("/create") && req.method === "POST") return handleCreate(req, deps);
  if (path.endsWith("/notify") && req.method === "POST") return handleNotify(req, deps);
  return json({ error: "Not found" }, 404);
}

// ---------- Supabase wiring (REST via fetch, same style as db.js) ----------

function authHeaders(key: string): Record<string, string> {
  // Legacy service keys are JWTs and work as a bearer token; the newer
  // sb_secret_ keys are not JWTs and go in `apikey` only.
  return key.startsWith("eyJ") ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

export function makeDb(config: Config, fetchImpl: typeof fetch): Db {
  const rest = (path: string, init: RequestInit = {}) =>
    fetchImpl(`${config.supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: { ...authHeaders(config.serviceKey), "Content-Type": "application/json", ...(init.headers || {}) }
    });

  async function ok(res: Response, what: string): Promise<Response> {
    if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
    return res;
  }

  return {
    async getUser(token) {
      const res = await fetchImpl(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { apikey: config.serviceKey, Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return null;
      const user = await res.json();
      return user && user.id ? { id: user.id } : null;
    },
    async isOwner(userId) {
      const res = await ok(await rest(`organisers?id=eq.${encodeURIComponent(userId)}&select=role,status`), "isOwner");
      const rows = await res.json();
      return rows.length > 0 && rows[0].role === "owner" && rows[0].status === "active";
    },
    async insertPayment(row) {
      await ok(await rest("payments", { method: "POST", body: JSON.stringify(row) }), "insertPayment");
    },
    async getPayment(id) {
      const res = await ok(await rest(`payments?id=eq.${encodeURIComponent(id)}&select=*`), "getPayment");
      const rows = await res.json();
      return rows[0] || null;
    },
    async updatePaymentIfPending(id, patch) {
      const res = await ok(
        await rest(`payments?id=eq.${encodeURIComponent(id)}&status=eq.pending`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(patch)
        }),
        "updatePayment"
      );
      return (await res.json()).length > 0;
    },
    async logEvent(row) {
      await ok(await rest("payment_events", { method: "POST", body: JSON.stringify(row) }), "logEvent");
    }
  };
}

// Only runs inside Supabase (Deno); under Node (the tests) this is skipped.
declare const Deno: any;
if (typeof Deno !== "undefined") {
  Deno.serve(async (req: Request) => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (path.endsWith("/status") && req.method === "GET") return handleStatus(Deno.env);
    try {
      const config = readConfig(Deno.env);
      return await handleRequest(req, { config, fetch, db: makeDb(config, fetch), uuid: () => crypto.randomUUID() });
    } catch (err) {
      console.error(err);
      return json({ error: "Payments aren't set up correctly yet." }, 500);
    }
  });
}
