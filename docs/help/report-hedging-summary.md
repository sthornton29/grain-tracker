---
page_route: /reports/hedging-summary
title: Hedging Summary
updated: 2026-08-05
keywords: hedging, futures, options, positions, realized, unrealized, profit and loss, crop year, commodity, lender
---
## What this page is for

The Hedging Summary gathers every futures and options position — open and closed — into one report, summarized by crop year and commodity with realized and unrealized profit and loss. It is written to be lender-ready: the export is the clean statement of your hedge book a banker or business partner expects, without them needing to know your trading platform.

## How to use it

Pick a crop year and, if you want, a commodity. The summary table shows each crop year × commodity combination with total contracts, bushels (or pounds for cotton), average hedge price, unrealized P&L on open futures, realized P&L net of commission on closed ones, options P&L, and the combined net. The detail table below lists every position — month, symbol, side, quantity, prices, and its own P&L. Date filters let you cut the report to a statement period.

## What the controls do

- **Crop year** — which marketing year's positions to show; each position is tagged to the crop year it hedges.
- **Commodity** — narrow to corn, soybeans, wheat, cotton, and so on.
- **Entity filter** — positions in an entity's own name count wholly toward it; positions held by your marketing agent or entered without an entity are hedging for the whole operation.
- **Date range** — filters positions by trade date, or close date for closed positions.
- **Export Excel / PDF / Print** — the summary and full position detail with your filters named.

## How the numbers work

- **Unrealized P&L** applies to open futures positions: the move from your trade price to the most recent market price, times contracts, times the contract size. It changes as the market does.
- **Realized P&L** applies to closed positions: the booked gain or loss, minus commission. It is final.
- **Average hedge price** is the contract-weighted average trade price of the futures positions in the row.
- **Options** show unrealized value only when you have entered a current value on the position — there is no live options quote here — while closed options report their booked result.
- Quantities and prices stay in each commodity's own units: bushels and dollars per bushel for grain, pounds and cents per pound for cotton.
- The summary's net P&L per row is futures unrealized + futures realized + options, so the pieces always reconcile to the total.

For **read-only users**, positions held by the marketing agent or without an entity are shown scaled to the granted entities' share of planted acres — so contract counts can show fractions and bushels can be partial. The prices are untouched; only the size of the slice changes.

## Common questions

- **Why did unrealized P&L change since yesterday?** It is marked to the latest market price. Only closed positions are locked.
- **Why does an option show no unrealized value?** No current value has been entered for it. Enter one on the Hedging page and it will appear here.
- **Why do I see 1.6 contracts?** You are viewing as a read-only user with an entity share — operation-level positions are split by acre share, and fractions are the honest way to show your portion.
- **Does this include the hedge gains already counted in my average price?** The Marketing Dashboard folds realized hedge P&L into its price buildup; this page is the position-level view of the same money. Use this one for the hedge book, that one for the blended price.

## If something looks wrong

If a position is missing, check its crop year tag on the Hedging page — a mistagged year moves it to a different summary row. If unrealized P&L looks stale, the market quote may not have refreshed recently; check back, and if it stays frozen, contact support.
