// Entry-fee maths: what a team pays, and how it splits between the organiser
// and the platform. Pure logic, same shape as league-rules.js - runs in the
// browser and in Node tests. All money is whole cents.
//
// The organiser sets a price per team. The platform adds PLATFORM_PERCENT on
// top, so the team pays fee + 20% as ONE price. The payment function
// (supabase/functions/payfast/index.ts) has its own copy of priceFor() - it
// can't import this file because it is deployed as a single file - and a test
// checks the two always agree.
(function (root) {
  const PLATFORM_PERCENT = 20;
  const MIN_FEE_CENTS = 500; // PayFast's minimum payment is R5.00 before our 20%
  const MAX_FEE_CENTS = 500000; // R5000 - a sanity limit against a typo

  // "150", "150.5", "R 1 500,00" -> cents, or null if it isn't a sensible amount.
  function parseRand(text) {
    const cleaned = String(text === undefined || text === null ? "" : text)
      .replace(/[R\s]/gi, "")
      .replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    return Math.round(Number(cleaned) * 100);
  }

  function formatRand(cents) {
    return `R${(cents / 100).toFixed(2)}`;
  }

  // { fee, platform, total } in cents. platform is rounded to the nearest cent.
  function priceFor(feeCents) {
    const platform = Math.round((feeCents * PLATFORM_PERCENT) / 100);
    return { fee: feeCents, platform, total: feeCents + platform };
  }

  // null when fine, otherwise a message for the organiser.
  function validateFee(cents) {
    if (cents === null) return "Enter the entry fee as an amount in rand, like 150 or 150.50.";
    if (cents < MIN_FEE_CENTS) return `The entry fee must be at least ${formatRand(MIN_FEE_CENTS)}.`;
    if (cents > MAX_FEE_CENTS) return `The entry fee can't be more than ${formatRand(MAX_FEE_CENTS)}.`;
    return null;
  }

  // A league charges teams only when it has a positive fee.
  function leagueHasFee(league) {
    return !!(league && league.entry_fee_cents > 0);
  }

  const EntryFee = { PLATFORM_PERCENT, MIN_FEE_CENTS, MAX_FEE_CENTS, parseRand, formatRand, priceFor, validateFee, leagueHasFee };
  if (typeof module !== "undefined" && module.exports) module.exports = EntryFee;
  else root.EntryFee = EntryFee;
})(typeof window !== "undefined" ? window : globalThis);
