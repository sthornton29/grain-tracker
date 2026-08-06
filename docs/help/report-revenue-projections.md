---
page_route: /reports/revenue-projections
title: Revenue Projections
updated: 2026-08-05
keywords: revenue, profit, breakeven, crop sales, insurance proceeds, government payments, ARC, PLC, cost per acre, average price
---
## What this page is for

Revenue Projections is the one-page financial summary of a crop year: every revenue source — crop sales, crop insurance proceeds, and government payments — alongside your costs, projected profit, and breakevens, crop by crop with operation totals. It is the page to hand a lender who asks "what is the whole year going to look like?"

## How to use it

Pick a crop year and, if you want, an entity. The summary tiles show total revenue, total cost, total profit, and profit per acre. Below them, the revenue table lists each crop's acres, yield, production, crop sales revenue, insurance proceeds, government payments, and revenue per acre; the profitability table adds cost, profit, the headline Total Avg Price, and both breakevens. The collapsible **How this is calculated** panel on the page walks through the same methodology described here.

## What the controls do

- **Crop year** — the year everything reports on.
- **Entity filter** — narrows acres, production, policies, and payments to that entity. Contracts and hedges held by your marketing agent, or entered with no entity, are whole-operation marketing: they count toward each entity by its share of the crop's planted acres, while an entity's own-name contracts stay wholly its own.
- **Export Excel / PDF / Print** — the full summary with the filter line included.

## How the numbers work

- **Crop sales revenue** is the same blended figure as the Marketing Dashboard: every bushel valued at its own price — cash sales at cash, futures-priced contracts at futures plus basis, open hedges and unpriced bushels at the relevant futures plus assumed basis — with realized futures and options gains counted once. Your standing assumptions from the Marketing Dashboard's What-If flow straight through here.
- **Cotton** buckets its pounds the same way: sold lint at locked prices, pool lint at dollars received plus the pool estimate, in-loan lint at the higher of the banked loan value or the market (the loan is the floor), held lint at the market or assumed price, net of fees. LDP payments and marketing loan gains count once inside cotton sales — never again under government payments.
- **Insurance proceeds** are estimated indemnities minus premium, from the same engine as the Claims Monitor.
- **Government payments** are attributed to the year the money arrives: for crop year Y, that is the prior program year's ARC/PLC (paid in October of year Y) plus other USDA payments landing in Y, allocated across crops by planted acres.
- **Breakeven** is sales-only: breakeven price = cost per acre ÷ yield, breakeven yield = cost per acre ÷ the Total Avg Price. The insurance and government safety net is in total revenue but deliberately not folded into breakeven.

This page and the Marketing Dashboard are built on the same math, so with no insurance or government payments the two profits match to the cent — insurance and payments are the only difference.

## Common questions

- **Why does profit here differ from the Marketing Dashboard?** Only because this page adds insurance proceeds and government payments. The crop sales line itself is identical.
- **Are these final numbers?** Not until after harvest. Insurance proceeds and harvest prices are estimates until RMA finalizes them, and unpriced bushels ride on your assumptions — watch for figures that depend on them.
- **I'm a read-only user — do my assumption edits show here?** Yes, as your private scenario: values you change flow into your view of this page, and an administrator's change replaces them.

## If something looks wrong

If a crop is missing, it likely has no yield assumption yet — set one on the Marketing Dashboard. If revenue looks too high or low, check the assumed futures and basis there, since they value every unpriced bushel. If a government payment seems absent, confirm which year it was received in; payments count in the year they arrive. Otherwise, contact support.
