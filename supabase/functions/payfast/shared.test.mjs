// node --test supabase/functions/payfast/shared.test.mjs
// The browser-side money maths (entry-fee.js, payments-ledger.js) and the
// rules module's entry-fee option.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { priceFor as serverPriceFor, PLATFORM_PERCENT } from "./index.ts";

const require = createRequire(import.meta.url);
const EntryFee = require("../../../entry-fee.js");
const { leagueLedger } = require("../../../payments-ledger.js");
const LeagueRules = require("../../../league-rules.js");

test("page and server price maths always agree", () => {
  assert.equal(EntryFee.PLATFORM_PERCENT, PLATFORM_PERCENT);
  for (const cents of [500, 999, 1234, 5000, 12345, 15000, 19999, 50000, 500000]) {
    assert.deepEqual(EntryFee.priceFor(cents), serverPriceFor(cents), String(cents));
  }
});

test("parseRand", () => {
  assert.equal(EntryFee.parseRand("150"), 15000);
  assert.equal(EntryFee.parseRand("R150"), 15000);
  assert.equal(EntryFee.parseRand("R 150.50"), 15050);
  assert.equal(EntryFee.parseRand("150,5"), 15050);
  assert.equal(EntryFee.parseRand("0.99"), 99);
  assert.equal(EntryFee.parseRand(""), null);
  assert.equal(EntryFee.parseRand("abc"), null);
  assert.equal(EntryFee.parseRand("-5"), null);
  assert.equal(EntryFee.parseRand("1.234"), null);
});

test("validateFee", () => {
  assert.equal(EntryFee.validateFee(15000), null);
  assert.equal(EntryFee.validateFee(500), null);
  assert.match(EntryFee.validateFee(499), /at least/);
  assert.match(EntryFee.validateFee(500001), /more than/);
  assert.match(EntryFee.validateFee(null), /Enter/);
});

test("formatRand and leagueHasFee", () => {
  assert.equal(EntryFee.formatRand(18000), "R180.00");
  assert.equal(EntryFee.formatRand(5), "R0.05");
  assert.equal(EntryFee.leagueHasFee({ entry_fee_cents: 15000 }), true);
  assert.equal(EntryFee.leagueHasFee({ entry_fee_cents: 0 }), false);
  assert.equal(EntryFee.leagueHasFee({}), false);
  assert.equal(EntryFee.leagueHasFee(null), false);
});

const entry = (status, amount = 18000, fee = 15000, platform = 3000) => ({ purpose: "team_entry", status, amount_cents: amount, fee_cents: fee, platform_cents: platform });

test("ledger: completed payments split between organiser and platform", () => {
  const l = leagueLedger([entry("complete"), entry("complete"), entry("pending"), entry("failed")], []);
  assert.equal(l.teamsPaid, 2);
  assert.equal(l.teamsPending, 1);
  assert.equal(l.collected, 36000);
  assert.equal(l.organiserShare, 30000);
  assert.equal(l.platformShare, 6000);
  assert.equal(l.owedToOrganiser, 30000);
});

test("ledger: payouts reduce what is owed", () => {
  const l = leagueLedger([entry("complete"), entry("complete")], [{ amount_cents: 10000 }, { amount_cents: 5000 }]);
  assert.equal(l.paidOut, 15000);
  assert.equal(l.owedToOrganiser, 15000);
});

test("ledger: a refund before any payout means repaying the organiser the full amount", () => {
  // Team pays R180; organiser refunds R180; Owner repays R180 - nobody gains or loses.
  const l = leagueLedger([entry("refunded")], []);
  assert.equal(l.teamsRefunded, 1);
  assert.equal(l.refundedAmount, 18000);
  assert.equal(l.owedToOrganiser, 18000);
});

test("ledger: a refund after the organiser was already paid out", () => {
  // Paid out R150 first, then the team is refunded: only R30 more is owed (R180 total back to organiser).
  const l = leagueLedger([entry("refunded")], [{ amount_cents: 15000 }]);
  assert.equal(l.owedToOrganiser, 3000);
});

test("ledger ignores test payments", () => {
  const l = leagueLedger([{ purpose: "test", status: "complete", amount_cents: 1000 }], []);
  assert.equal(l.teamsPaid, 0);
  assert.equal(l.collected, 0);
});

test("rules: entry-fee rules appear only when the league has a fee", () => {
  const without = LeagueRules.build(LeagueRules.defaultConfig());
  const withFee = LeagueRules.build(LeagueRules.defaultConfig(), { payments: true });
  assert.ok(!without.items.some((r) => r.key === "entry-fee" || r.key === "refunds"));
  assert.ok(withFee.items.some((r) => r.key === "entry-fee"));
  assert.ok(withFee.items.some((r) => r.key === "refunds"));
  // Everything else is identical, so existing rules text never changes.
  const stripped = withFee.items.filter((r) => r.key !== "entry-fee" && r.key !== "refunds");
  assert.deepEqual(stripped, without.items);
});
