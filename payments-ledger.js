// The Owner's payout ledger: for one league, what teams have paid, what is
// owed to the organiser, and what the platform keeps. Pure logic (no fetch,
// no DOM) so it can be tested in Node. All money is whole cents.
//
// Refunds follow the agreed rule: the organiser refunds the team the FULL
// amount it paid, and the Owner repays the organiser that full amount. So a
// refunded payment adds its whole amount to what the Owner owes the
// organiser, in place of the organiser's normal share:
//
//   owed to organiser = (fee share of completed payments)
//                     + (full amount of refunded payments)
//                     - (payouts already made)
(function (root) {
  const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) || 0), 0);

  // payments: every payment row for ONE league; payouts: payout rows for the
  // same league. Only team entry payments count (test payments are ignored).
  function leagueLedger(payments, payouts) {
    const entries = payments.filter((p) => p.purpose === "team_entry");
    const complete = entries.filter((p) => p.status === "complete");
    const refunded = entries.filter((p) => p.status === "refunded");
    const pending = entries.filter((p) => p.status === "pending");

    const collected = sum(complete, (p) => p.amount_cents);
    const organiserShare = sum(complete, (p) => p.fee_cents);
    const platformShare = sum(complete, (p) => p.platform_cents);
    const refundedAmount = sum(refunded, (p) => p.amount_cents);
    const paidOut = sum(payouts, (p) => p.amount_cents);

    return {
      teamsPaid: complete.length,
      teamsPending: pending.length,
      teamsRefunded: refunded.length,
      collected,
      organiserShare,
      platformShare,
      refundedAmount,
      paidOut,
      // Positive: the Owner still owes the organiser this much. Negative: the
      // organiser has been paid more than they are owed (e.g. a refund was
      // marked after a payout was made).
      owedToOrganiser: organiserShare + refundedAmount - paidOut
    };
  }

  const PaymentsLedger = { leagueLedger };
  if (typeof module !== "undefined" && module.exports) module.exports = PaymentsLedger;
  else root.PaymentsLedger = PaymentsLedger;
})(typeof window !== "undefined" ? window : globalThis);
