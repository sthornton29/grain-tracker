---
page_route: /contracts/seed
title: Seed production contracts
updated: 2026-09-01
keywords: seed, seed contract, seed production, seed beans, grower agreement, elections, pricing election, premium, premium cap, irrigated premium, usage fee, storage pay, selection date, acceptance, released, rejected, Bayer
---
## What a seed contract is

A seed production agreement is different from selling grain. You commit **acres** — named fields growing the seed company's variety — not a bushel count. Whatever those fields produce belongs to the seed company. In return you get to price the bushels on your own timing against a named local elevator's posted price, and a premium rides on top of that price once the company accepts the crop as seed.

Turnrow tracks all of it: the agreement's terms, your pricing elections, the staged payments, and how it all rolls into the marketing and cash-flow reports.

## Entering one

On the Contracts page, **New Contract → Seed contract** opens the dedicated form. Type the terms in, or upload the signed agreement (PDF or photos) — Turnrow reads the signature page and the premium/payment terms and fills the form in for your review. Nothing saves until you confirm.

The important pieces:

- **Contract acres and forecast yield** — together they set the estimated quantity, but the real committed production comes from the **fields you link** on the form. Until harvest, those fields count at their expected yield; after harvest, at their actual bushels.
- **Local market for pricing** — the elevator whose posted price your elections use (for example, a river terminal named in the agreement).
- **Price everything by** — the agreement's deadline (Selection Date). All the bushels need a price by then.
- **Premium schedule** — what the company pays on top of your elected price, per outcome: the full stack if the seed is *accepted*, usually less if it's *released* back to you, nothing if *rejected*. Some premiums (like an irrigated premium) pay only on irrigated bushels, and the total is capped per bushel. The form starts from a typical schedule — edit every row to match your agreement.
- **Usage fee** — the per-bushel fee the company nets out of your settlement.

## Pricing elections

You price the crop in 25% pieces (25 / 50 / 75 / 100), each at the local market's price that day or a target order that filled. Record each one on the contract's page — "Price 25% at $10.42 — elected 11/3" — and the page keeps the running total priced. Turnrow won't let elections go past 100%.

## Why premiums are an assumption until acceptance

The premium stack only pays in full if the company accepts the crop as seed — and that decision comes after harvest. Until then, every projection in Turnrow values the premiums at the **expected outcome** you've set on the contract (it starts at *Accepted*). If you want to plan conservatively, change the expected outcome and every report follows. When the company settles, record the real payments and the projections step aside.

## Payments

Seed contracts pay in stages: typically 80% of the base price after delivery and pricing, the final 20% plus premiums at final settlement (often the following spring), storage pay monthly if you hold the crop, and the usage fee netted out. Record each payment on the contract's page as it arrives. The **Cash Flow report** projects the stages until the real payments replace them, and the contract shows **complete** once the final base payment is received.

## Where it shows up in reports

- **Marketing** — the linked fields' bushels count as committed to the seed company, with their own segment in the position bar and a "Seed — [company]" tag. Elected bushels hold their elected price plus expected premiums; unpriced bushels move with the market (marked "seed est.").
- **Income Sensitivity** — elected portions stay locked; unpriced seed bushels move with the scenario price. Premiums stay at the expected-outcome assumption.
- **Cash Flow** — the staged payments appear as labeled seed lines with their own column.
- **Revenue Projections** — the seed dollars are inside crop sales revenue, so everything still adds up.

## Common questions

- **Why does the contract show "(est.)" bushels?** The linked fields haven't finished harvest, so committed production is still the expected yield. It switches to actual bushels when harvest wraps up.
- **Can I sell grain off the seed fields to someone else?** No — the agreement commits everything those fields produce, and Turnrow treats it that way: seed-field bushels never count as available for grain contracts.
- **What if the crop is released back to me?** Set the expected outcome to *Released* so projections use that premium level; the released bushels are yours to market as grain at that point.

## If something looks wrong

- The committed bushels look off: check which fields are linked on the contract (Edit) and the crop's expected yield under the Marketing page's assumptions.
- Premiums look too high or low: open the contract and check the premium schedule rows, the irrigated acres on the linked fields, and the premium cap.
- Anything else: contact support.
