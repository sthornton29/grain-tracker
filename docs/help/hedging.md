---
page_route: /hedging
title: Hedging
updated: 2026-09-14
keywords: hedging, futures, options, positions, open, closed, realized, unrealized, brokerage statement, commissions, P&L, market prices, manual quote, manual price, cotton price, no live price, enter price, stale quote, roll, rolled, roll forward, spread, effective price, history, audit trail, who changed, when, statement import, partial roll
---
## What this page is for

Hedging tracks your futures and options positions alongside the crops they protect. Open positions are valued against current market prices so you can see where you stand today; closed positions keep their final results by crop year. Summary cards roll everything up by crop year and commodity.

## How to use it

- **New position** records a trade: commodity, contract month, buy or sell, number of contracts, price, date, and account. Options carry strike and premium as well.
- When you offset a trade at the brokerage, use **Close** on the position and enter the closing price, date, and commission. The result moves from unrealized to realized.
- When you move a hedge out to a later month, use **Roll…** on the position: pick the new month, enter the price the old month closed at and the price the new month opened at, the date, and any fees. Turnrow closes the old leg, opens the new one, and links the two — the new month keeps the same crop year automatically.
- Or skip the typing: **import a brokerage statement** (photo or PDF). Turnrow reads the open positions, closed trades, rolls, and cotton alongside the grains, shows everything on a review screen, and saves only what you confirm.
- Filter between open, closed, and all; closed positions can be narrowed by date range.
- Switch the page between **Positions** and **History**. History is the running record of everything that ever happened to your hedges, newest first.

## What the controls do

- **Open / Closed tables** — open positions show live gain or loss at current prices; closed positions show the locked-in result net of commissions.
- **Statement import** matches what it reads to positions you already have, so re-importing a statement doesn't duplicate anything. Closed trades come in lot by lot: each opening lot becomes its own closed position with its own result, and the lots are checked against the statement's total — a disagreement over a dollar is flagged on the review screen for you to look at.
- The import also runs a second check: positions Turnrow shows open that don't appear on the statement are flagged as possibly closed. You choose — **Close this position** (which walks through the normal close, nothing closes automatically) or **Keep open**.
- Cotton is handled in its own terms throughout: pounds instead of bushels, cents per pound instead of dollars per bushel.

## How the numbers work

- **Unrealized** is what an open position would make or lose if you offset it at the current market price: the difference between today's price and your trade price, times contracts, times the contract size. It changes with the market and isn't money in the bank.
- **Realized** is the locked-in result of a closed position: the difference between your opening and closing prices, times contracts, times contract size, minus commissions. It no longer moves.
- A sold (short) position gains when prices fall; a bought (long) position gains when prices rise.
- Options are valued off their premium: what you paid or collected versus what the option is worth now (open), or what you closed it at (closed).
- Market prices on this page are for valuing open positions and are delayed quotes — they're a gauge, not a fill price.

## Rolling a hedge to a later month

A roll closes one contract month and opens the next in the same crop's hedge — say, DEC corn rolled out to MAR. Turnrow treats the two halves as one event, not two unrelated trades.

- **Rolled positions carry a chip** on the open table — "rolled from DEC 26 @ 4.9525" — and, beside the new leg's own open price, an **effective price** since the original entry. That is the original price plus or minus what each roll cost: entered at 4.9525, closed DEC at 5.435 and opened MAR at 5.585, the roll added 15 cents, so the hedge now reads at 5.1025. Roll again and the next spread adds on. It is the price the whole crop-year hedge really sits at.
- **Statement imports find rolls for you.** When a statement shows a month closed and a different month opened the same day, same commodity, same direction, same number of contracts, the review screen shows it as one line — *Rolled 14 DEC 26 → MAR 27 on 9/03: closed DEC @ 5.435 → realized −$33,775.00; opened MAR @ 5.585 · crop year 2026 (inherited)* — with a single **Treat as roll** box already ticked. Both halves save together, linked, and the new month takes the crop year of the position it replaces. You are never asked for that crop year again.
- A roll placed as one spread order at the brokerage is recognized with the most confidence. A close and an open placed separately the same day still show as a roll, marked *same day, no spread code*, so you can untick the box if they really were unrelated. Rolling fewer contracts than you held (a partial roll) works the same way; the contracts that did not roll stay open.
- If you untick **Treat as roll**, the close and the open import as two independent trades, exactly as before.
- Rolling changes nothing in your marketing numbers: the closed leg's result is counted once and the new leg is valued at its own price, which comes to the same money as the effective price. The effective price is there so you can read the hedge at a glance.

## History — the record of every change

Every open, close, partial close, roll, edit, crop-year change, delete, and statement import is recorded the moment it happens, and the record can be read but never rewritten.

- The **History** view on this page lists one plain line per event, newest first — "9/03 · Rolled 14 DEC 26 → MAR 27 corn · −$33,775.00 realized · from StoneX statement 9/03". Tap a line for the detail: prices, fees, the roll lineage, which statement it came from, who recorded it and when, and for edits, exactly what changed from what to what. The crop year, commodity, and entity filters above apply to History too.
- **History** on any position (open or closed) shows that position's own chain, and for rolled positions the whole lineage across legs with the effective price.
- The same trail prints and exports from the **Hedging Summary** report as a *Hedging Activity* section — one row per event, in date order, with every detail column — so a full account history comes out of the report a lender already sees.
- Positions that existed before this record began carry their opening and closing entries from their own dates, marked *from existing records*.

## When a price says "manual"

Turnrow's live price feed covers corn, soybeans, and wheat. It does not cover **cotton** (ICE Cotton No. 2), and once in a while a contract month or the whole feed is unavailable. Rather than leave the number blank, any contract with no live price shows an **enter price** box — on the price board here, and anywhere else that price is needed (the Marketing Dashboard's what-if, the Income Sensitivity price axis, the Crop Budget Planner). Type the settlement from your broker or the exchange and it is saved for that contract; every screen then uses it. Cotton can be typed either way, $0.7265 or 72.65 — both mean the same price and display as dollars per pound.

- A price you typed is never dressed up as market data: it carries an amber **manual · 9/2** chip (the date you entered it) everywhere it appears — the price board, the marketing price buildup, axis headers, and the unrealized P&L rows it feeds.
- The chip warns when the price gets old: after a week it says the quote is a week old; after a month it turns red. Update it by typing over it — the same box.
- If live coverage comes back for that contract, the live price takes over automatically and the manual one is kept only as a fallback.
- Importing a brokerage statement that lists a settlement for a contract you have a manual quote on (or none) offers to update the manual quote to the statement's close with one tap.

## Common questions

- **Why does my unrealized number bounce around?** It's marked to the current market. Only closing the position locks a number in.
- **My total doesn't match the brokerage's month-end.** Check commissions on manually closed trades, and make sure every statement has been imported. Statement totals are reconciled on import, and disagreements were flagged then.
- **The import says a position is "possibly closed" but it isn't.** Choose Keep open. The flag only means the statement didn't list it — a partial statement can cause that.
- **A roll came in earlier as two separate trades — can I fix it?** Yes. Import that day's statement again: the review finds the roll, shows both halves as already recorded, and links them when you save. Nothing is duplicated, the new month picks up the right crop year, and the possibly-closed step stops flagging the old month.
- **Why does the new month show two prices?** The first is what the new leg actually opened at; the smaller *eff.* figure is the effective price since the original entry, with the roll spreads folded in.
- **Do hedge results show up in my marketing numbers?** Yes — realized futures results flow into the marketing and revenue reports, counted once, per crop year.
- **Why are there no live prices right now?** Quotes can be temporarily unavailable; positions are still there, and any contract without a price offers an **enter price** box so you can carry on with a manual quote. If live prices never come back for corn, soybeans, or wheat, contact support.
- **Why is my cotton price always "manual"?** Cotton (ICE) is not in the live feed. Enter the settlement when you check it — it is remembered until you change it.

## If something looks wrong

- A doubled position after an import: check whether the same trade was also entered by hand, and delete the duplicate.
- A wrong realized number: open the position and verify the close price, contract count, and commission.
- Lot totals flagged against the statement: trust the statement, edit the lots to match.
- Anything beyond that: contact support.
