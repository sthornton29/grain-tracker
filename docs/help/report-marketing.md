---
page_route: /reports/marketing
title: Marketing Dashboard
updated: 2026-09-08
keywords: marketing, contracts, futures, basis, cash price, unpriced bushels, assumptions, what-if, profit, breakeven, harvest complete, still harvesting, count anyway, cotton, reference contract, contract month, expired, front month, assumed acres, next year, future crop year, no plantings yet, plan ahead, sold ahead
---
## What this page is for

The Marketing Dashboard shows where you stand on selling each crop for a crop year. Every crop gets its own full-width section: production, acres, yield, the average price built from futures and basis, profit per acre, and total profit, with position bars underneath showing how much is sold or priced and how much is still open. It is the page to check before making the next sale.

## How to use it

Pick a crop year, then scroll through the crop sections. The chevron on each section expands a detail view that reads like a statement: the futures price buildup source by source, the basis buildup, and profitability side by side. Enter your yield and cost assumptions once through **Edit Assumptions**; use the **What-If** row to value your unpriced bushels at a futures price and basis you choose.

## What the controls do

- **Crop year and entity filter** — the crop year list always includes this year and the next two, plus any year you already have plantings, contracts, hedges, or assumptions for — so next year's marketing has a place to live before anything is planted. The entity filter narrows acres and production to that entity. Contracts and hedges held by your marketing agent — or entered with no entity — are marketing for the whole operation, so they count toward each entity in proportion to its share of that crop's planted acres. A contract in an entity's own name counts wholly toward it.
- **Edit Assumptions** — a panel with one section per crop: enter an overall yield and cost per acre, or break them out by irrigated/dryland and full-season/double-crop. A blank breakout cell falls back to the overall figure. The **Harvest complete** checkbox tells Turnrow the crop is finished; checking it snaps the yield to the actual average from your loads.
- **Assumed acres (planning a year before planting)** — for a crop year with no plantings yet, each crop's section in the panel takes **assumed acres** instead: an overall figure, or split by irrigated/dryland like the yield. The Double-crop rows appear only for a crop designated Double-crop under Settings → Crops (soybeans after wheat); every other crop shows just Irrigated and Dryland. If you later change a crop's designation, acres already entered in a Double-crop row are not lost — a note says so and offers to clear them. Enter the acres and the expected yield and the dashboard values the year's contracts and hedges against that expected production — 2027 wheat you've already sold ahead, 2028 corn you've hedged. Crops with no acres assumed stay off the dashboard. The moment the first field is planted to a crop for that year, the **planted acres take over automatically** and the assumed figure is ignored (the panel then reads "using planted acres"). Assumed acres are for the whole operation, so they show under **All entities**; an entity filter still goes by the fields actually planted.
- **What-If on Unpriced Bushels** — type an assumed futures price (or use the **use today's price** button, which fills in the current quote for the reference contract shown) and an assumed basis. These are standing assumptions: they save automatically, stay until you change them, and flow into every headline number here and on Revenue Projections. **Clear assumptions** wipes both.
- **The reference contract** — shown next to the futures input as the board month and its live quote (for example "ZWU26 · $5.72"). This is the futures contract your unpriced bushels are valued against. The default is the crop year's new-crop month — December corn and cotton, November soybeans, July wheat — and once that contract stops trading (around the middle of its delivery month), Turnrow automatically moves to the next traded month and shows a small note like "Jul 26 expired → Sep 26". You can also pick a different month from the dropdown — any traded month from this crop year through the next — and your choice sticks for that crop and year until you press **Reset to default**. The Income Sensitivity price axis and Revenue Projections follow the same contract, so every page prices unpriced bushels off one answer.
- **Physical Sales Complete for the Year?** — checkboxes at the bottom, one per crop. Because shrink and small leftovers keep the math from ever landing on exactly zero, this is how you tell Turnrow a year's selling is truly finished.
- **Export Excel / PDF / Print** — the full dashboard, formatted for handing to a lender.

## How the numbers work

Production is your assumed acres × yield until you mark harvest complete; after that it is the actual bushels from your loads (pounds of lint from gin receipts for cotton). Turnrow also switches to actuals on its own once every field of a crop is harvested. If a crop hasn't switched because a field still shows as being harvested, an amber note at the top names the field — tap **Count anyway** there if it's actually done, and its bushels count as final everywhere. Every bushel is valued at its own price: cash sales at their cash price, HTA and basis contracts at their locked legs, hedged bushels at their trade price with realized futures and options gains counted once, and unpriced bushels at your assumed futures plus assumed basis (or, with no assumption entered, the reference contract's current quote). Basis totals show their state — actual where locked, assumed where not, and a blend when it is some of each.

An amber **includes assumptions** marker appears whenever any production is not fully priced; its tooltip breaks down how many bushels ride on assumed futures or basis. A crop running on assumed acres carries an **acres assumed — no plantings yet** badge and an "assumed" chip on its acres, and the export labels the line "Assumed acres (no plantings yet)". Revenue Projections, Income Sensitivity, and Cash Flow use the same acres, so the whole set of reports works for a future year. Profit is this blended revenue minus your cost per acre, and it matches Revenue Projections to the cent. Breakeven price is cost divided by yield; breakeven yield is cost divided by average price.

Cotton sections work in pounds and cents per pound, with a position bar covering sold, pool, in-loan, hedged, and unpriced lint.

A crop with a **seed production contract** shows a "Seed — [company]" tag and its own segments in the position bar: the linked seed fields' bushels count as committed, elected portions hold their elected price plus the expected premiums, and the unpriced share is valued at the reference price (marked "seed est."). Premiums stay assumptions until the seed company accepts the crop — the contract's expected-outcome setting drives them.

## Common questions

- **Why did my average price move when I typed a What-If number?** The headline reflects your standing assumptions on unpriced bushels — that is the point. Clear them to see locked pricing only.
- **I'm a read-only user — can I try my own numbers?** Yes. Your edits are private "your scenario" values only you see, marked with a chip (assumed acres included). If an administrator later changes the official assumption, your scenario value is replaced and a notice tells you.
- **I picked next year and the page says there are no plantings yet.** That's expected before planting — open **Edit Assumptions**, give each crop you plan to grow its assumed acres and expected yield, and the dashboard fills in with the contracts and hedges already on file for that year.
- **I entered assumed acres but the dashboard shows a different number.** Fields have been planted to that crop for the year, and planted acres always win. Check Settings → Plantings; the assumptions panel names the planted total it is using.

## If something looks wrong

Check the assumptions panel first — a "needs yield" badge means a crop has no yield entered, and profit shows "Set costs" until cost per acre exists. If a contract seems missing under an entity filter, remember agent-held contracts are shared by acres. Otherwise, contact support.
