---
page_route: /cotton/marketing
title: Cotton Marketing
updated: 2026-10-20
keywords: cotton marketing, sales contract, on-call, pool, CCC loan, redeem, equity, forfeit, LDP, AWP, MLG, PBI, bale disposition, fees, checkoff, quality requirements, quality terms, contract spec, color grade, eligible farms, FSA, cap, qualifying bales, read quality terms from document
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
- **Quality terms** — on each sales contract's row. A merchant's contract can say which bales it will take ("Color 41 and better, leaf 3 and better, staple 37 and longer, micronaire 4.0–4.7, strength 29 and better, uniformity 80 and better"), from which farms (a schedule of FSA numbers), up to a cap, at a base-grade price. Tap **Quality terms** to see them, **Add quality requirements** to enter them by hand, or **Read quality terms from document** to upload the contract: Turnrow lifts the quality clause and the farm schedule as written and turns the wording into rules for you to check — "41 and better" becomes the white grades 11, 21, 31 and 41 on a tick-box color grid; a phrase it can't turn into a rule is shown as **not understood** with the original wording so you can set it by hand. Reading a document fills or updates only that contract's requirements and never creates a contract. When a contract is uploaded through **Upload Marketing Document** and carries quality terms, the same editor appears under the contract fields and saves with it.
- **The quality-terms editor** — the color grid (tick every accepted grade; quick buttons for "41 and better" and "31 and better"), leaf maximum, staple minimum, micronaire range, strength and uniformity minimums, the extraneous-matter rule, excluded remarks, the eligible farms by FSA number (each matched to your farms — a number no farm carries is flagged), a dryland-only switch (off unless the contract makes the practice a condition), the cap, the estimated bales, the base grade and price, the off-spec terms and other deliverables, with the contract's own wording kept beside the rules.
- Once saved, the contract row shows the compact view — how many classed bales from eligible farms meet the spec, the cap tracker, the top reasons bales fail — and a link to the **Bale Quality** report with that contract selected, where every bale carries a Meets / Fails / Not eligible / Not classed chip and the qualifying bales export for the buyer.

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
- **The reader said a quality phrase was "not understood".** It only turns plain wording into rules ("and better", "and longer", a range like 4.0–4.7). Set that factor by hand in the editor; the contract's wording stays beside it.
- **A farm on the contract's schedule shows as unmatched.** No farm under Settings → Farms carries that FSA number yet — add it there and the bales from that farm become eligible.

## If something looks wrong

- If principal looks off, check for "pending classing" bales and press Recompute after grades import.
- If a fee looks doubled, confirm the actual invoice replaced its projection rather than adding a second row.
- Anything else, contact support.
