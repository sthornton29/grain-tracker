---
page_route: /cotton/marketing
title: Cotton Marketing
updated: 2026-08-05
keywords: cotton marketing, sales contract, on-call, pool, CCC loan, redeem, equity, forfeit, LDP, AWP, MLG, PBI, bale disposition, fees, checkoff
---
## What this page is for

Cotton Marketing tracks what happens to your bales after the gin: sales contracts, CCC loans, LDPs, and the fees that ride along. The **Bale Disposition board** always shows where every bale stands — held, in loan, sold, pooled, or delivered — with counts and pounds and a per-bale drill-down. This page is owner-only; gin-operator logins never see it.

## How to use it

- **Sales Contracts** — four types, and the form adapts to each: **spot** (sold outright), **fixed** (price locked), **on-call** (basis set, futures month named, price open — a **Fix futures** button locks it later, and cash equals basis plus the fixed futures), and **pool** (a payments ledger tracks advances, progress payments, and the final).
- **CCC Loans** — pick held bales with the receipt-filtered picker. Principal per bale is its classing loan value in cents per pound times its pounds; an unclassed bale uses the base rate with a "pending classing" flag and a **Recompute** button once grades import. Maturity is nine months from entry. Three ways out: **Redeem** (enter the AWP — payoff and any marketing loan gain are computed, interest waived, bales return to held), **Equity sale** (enter the equity cents per pound and buyer — effective price is the banked loan value plus the equity), or **Forfeit**.
- **LDP** — enter an LDP instead of a loan. The rate fills in automatically as the loan rate minus the AWP, never below zero. A bale that takes an LDP can never go into loan, and a loan bale can never take an LDP — the app enforces it.
- **Fees** — set a per-year fee schedule (storage per bale per month, receiving, classing, checkoff plus the supplemental percentage, interest rate) and the page projects accruals; actual invoices replace the matching projection when entered.
- **AWP** — enter the weekly Adjusted World Price, or use the AI lookup with a confirm step.
- **Upload Marketing Document** — one button handles seven document kinds: sales contracts, pool payment notices, CCC loan documents (including the full PBI bale list), LDP notices, equity sale confirmations, warehouse/storage invoices, and bare bale-number lists. The app classifies the document, extracts its fields, and shows a pre-filled review panel — existing records are updated by their contract, loan, or invoice number, never duplicated. If the app isn't confident what the document is, it asks you to pick.
- **Assign bales from file** — on any bale picker, load a CSV, text list, or even a PDF or photo of a recap sheet. Bale numbers are matched by PBI, conflicts (wrong disposition, loan/LDP exclusion) are blocked with the reason, and unmatched numbers are listed verbatim.

## How the numbers work

- Loan principal: classing loan value × pounds (a 509-pound bale at 55.1 cents is $280.46).
- LDP rate and marketing loan gain are the same number: loan rate minus AWP, floored at zero.
- Redemption payoff: principal minus the marketing loan gain, interest waived.
- Equity sale effective price: banked loan value plus equity cents per pound.
- On-call cash price: basis plus the fixed futures — unpriced until you fix.
- The disposition board conserves every bale: nothing is dropped or double-counted.

## Common questions

- **Why is a loan blocked from re-upload?** The document's loan number matches a loan that is no longer open.
- **Why can't I pick certain bales?** They're already sold, in loan, pooled, or LDP'd — the picker shows the reason.

## If something looks wrong

- If principal looks off, check for "pending classing" bales and press Recompute after grades import.
- If a fee looks doubled, confirm the actual invoice replaced its projection rather than adding a second row.
- Anything else, contact support.
