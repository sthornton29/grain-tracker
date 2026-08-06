---
page_route: /hedging
title: Hedging
updated: 2026-08-05
keywords: hedging, futures, options, positions, open, closed, realized, unrealized, brokerage statement, commissions, P&L, market prices
---
## What this page is for

Hedging tracks your futures and options positions alongside the crops they protect. Open positions are valued against current market prices so you can see where you stand today; closed positions keep their final results by crop year. Summary cards roll everything up by crop year and commodity.

## How to use it

- **New position** records a trade: commodity, contract month, buy or sell, number of contracts, price, date, and account. Options carry strike and premium as well.
- When you offset a trade at the brokerage, use **Close** on the position and enter the closing price, date, and commission. The result moves from unrealized to realized.
- Or skip the typing: **import a brokerage statement** (photo or PDF). Turnrow reads the open positions, closed trades, and cotton alongside the grains, shows everything on a review screen, and saves only what you confirm.
- Filter between open, closed, and all; closed positions can be narrowed by date range.

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

## Common questions

- **Why does my unrealized number bounce around?** It's marked to the current market. Only closing the position locks a number in.
- **My total doesn't match the brokerage's month-end.** Check commissions on manually closed trades, and make sure every statement has been imported. Statement totals are reconciled on import, and disagreements were flagged then.
- **The import says a position is "possibly closed" but it isn't.** Choose Keep open. The flag only means the statement didn't list it — a partial statement can cause that.
- **Do hedge results show up in my marketing numbers?** Yes — realized futures results flow into the marketing and revenue reports, counted once, per crop year.
- **Why are there no live prices right now?** Quotes can be temporarily unavailable; positions are still there, only the unrealized column waits. If prices never load, contact support.

## If something looks wrong

- A doubled position after an import: check whether the same trade was also entered by hand, and delete the duplicate.
- A wrong realized number: open the position and verify the close price, contract count, and commission.
- Lot totals flagged against the statement: trust the statement, edit the lots to match.
- Anything beyond that: contact support.
