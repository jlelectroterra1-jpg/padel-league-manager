# PayFast Edge Function

One Supabase Edge Function (`index.ts`, a single file) that creates PayFast payments and receives PayFast's confirmation (ITN). Step 1 is **sandbox only**: the Owner-only "Payments Lab" tab makes a fixed R10.00 test payment.

This folder is excluded from the published website (see `.github/workflows/deploy.yml`).

## 1. Database

Run `sql/migration_010_payments.sql` in the Supabase SQL editor (adds `payments` and `payment_events`; touches nothing existing).

## 2. PayFast sandbox account

1. Create a free account at https://sandbox.payfast.co.za/ (separate from a real PayFast account - no ID or bank details needed).
2. In the sandbox dashboard go to **Settings → Integration** and note the **Merchant ID** and **Merchant Key**.
3. On the same page, set a **Passphrase** (any strong phrase - invent one) and make sure **ITN is enabled**.
4. The sandbox also gives you a test buyer account (Settings / "Sandbox" section) used to pay in the PayFast window.

Never paste the merchant key or passphrase into chat or the repo.

## 3. Secrets

Supabase dashboard → **Edge Functions → Secrets** (a.k.a. Manage secrets). Add:

| Name | Value |
| --- | --- |
| `PAYFAST_MODE` | `sandbox` |
| `PAYFAST_MERCHANT_ID` | from the sandbox Integration page |
| `PAYFAST_MERCHANT_KEY` | from the sandbox Integration page |
| `PAYFAST_PASSPHRASE` | the passphrase you set (must match exactly) |
| `SITE_URL` | `https://padelleaguemanager.co.za` (no trailing slash) |
| `SB_SERVICE_KEY` | the project's **service_role / secret** key (Project Settings → API). Only needed if `SUPABASE_SERVICE_ROLE_KEY` isn't injected automatically - setting it is harmless. |

`SUPABASE_URL` is provided by Supabase automatically. Secret names can't start with `SUPABASE_`.

## 4. Deploy

**Dashboard:** Edge Functions → **Deploy a new function → Via Editor**. Name it exactly `payfast`, paste the whole of `index.ts`, and deploy. Then open the function's settings and **turn off "Verify JWT with legacy secret"** (PayFast's server can't send a Supabase login - `/notify` authenticates PayFast itself with the signature and PayFast's own validate call, and `/create` checks the Owner login inside the function).

**CLI alternative:**
```
supabase functions deploy payfast --no-verify-jwt
```

## 5. Check it's alive

Open `https://<project-ref>.supabase.co/functions/v1/payfast/status` in a browser. It should say `{"configured":true,"missing":[],"mode":"sandbox"}`. If something's missing it names the secret (never the value).

## 6. Try it

Sign in as Owner → **Owner dashboard → Payments Lab → Pay R10 (test)**. Pay in the PayFast sandbox window with the sandbox test buyer; on return the payment flips from `pending` to `complete` within a few seconds.

Negative checks (nothing should be created or changed):
```
curl -i -X POST https://<project-ref>.supabase.co/functions/v1/payfast/create
curl -i -X POST https://<project-ref>.supabase.co/functions/v1/payfast/notify -d "m_payment_id=x&payment_status=COMPLETE&signature=bad"
```
The first returns 401. The second returns 200 (so nothing retries) but is logged as `rejected:bad_signature` in `payment_events`.

## Tests

```
node --test supabase/functions/payfast/payfast.test.mjs
```
(Node 24+; runs the same TypeScript file that gets deployed, against fakes.)

## Going live later

Change the secrets only (`PAYFAST_MODE=live` plus the live merchant id/key/passphrase). In live mode ITNs from outside PayFast's published IP ranges are refused; in sandbox that check only notes it. Re-check PayFast's current IP ranges and signature rules in their developer docs first.
