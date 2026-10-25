---
page_route: /reports/bale-quality
title: Bale Quality
updated: 2026-10-25
keywords: cotton, bales, HVI, base loan rate, above base, below base, histogram, distribution, factor tile, filters drawer, classing, color grade, leaf, staple, micronaire, mic, strength, uniformity, loan value, premium, discount, price band, loan schedule, color grid, variety, class week, contract, quality requirements, spec, cap, qualifying bales, near miss, Pareto, buyer, merchant, excel formulas
---
## What this page is for

Bale Quality is the quality package a cotton producer shows a merchant — every classed bale's USDA classing results, cut any way the buyer asks. It appears in the Reports menu only when Cotton is turned on under Settings → Organization.

For the bales you choose it shows how many are classed, the lint pounds, the average loan value, how the bales spread across each grade factor, and how that spread prices: each bucket is colored by the crop year's CCC loan premium and discount schedule, so you can see at a glance what share of the crop earns a premium, sits at base, or takes a discount. Pick a contract that carries quality requirements and the report also tells you what portion of your bales meets it, how close you are to the contract's cap, and why the rest fall short.

## How to use it

- The **crop year** and the **contract** sit at the top of the page. Everything else waits behind the **Filters & display** button so the numbers lead; the line under the title always says which filters are on, and **Clear filters** next to the button turns them off.
- Open **Filters & display** to narrow the bales with chips: **entity, farm, field, variety, gin, gin receipt, practice** (dryland / irrigated / mixed), **class date range**, and **disposition** (held, in loan, sold, on contract, pool). Any mix of chips works together; a chip that would offer nothing isn't offered.
- The same drawer holds the **Weighting**: **Per bale** (how a classing recap is read) or **Per lb**; loan value is always pounds-weighted, whichever you pick.
- Every grade factor gets a slim **tile** — color, leaf, staple, micronaire, strength, uniformity, extraneous matter, remarks, Rd, +b, color quadrant, trash, length and loan value: its average (or its most common code), a thin premium / base / discount strip, and — with a contract — how many bales fail that factor. A factor your classing data doesn't carry says "no readings". **Tap a tile** to open the factor's detail underneath; tap it again, or the ✕, to close it.
- **Group by** and **Columns** live on the comparison table. Group by: Overall, Entity, Farm, Field, Variety, Gin, Receipt, or Class week. Columns picks which factors the table, the bale list and the exports carry: **Loan factors** (color, leaf, staple, mic, strength, uniformity, loan value — the default), **Mill specs**, or **Everything**. The Excel By Group tab follows both.
- Tap any histogram column, code row, color-grid cell, Pareto row, fail line or KPI card to filter the bale list to those bales. The blue "Showing" chip above the list clears it.
- **Export**: Excel builds a workbook with a Bales tab (every classed bale in the filter), a Summary tab and a By Group tab whose figures are live formulas over the Bales tab, and — with a contract selected — a Contract Spec tab. PDF and Print mirror the screen.

## What the controls do

- **Contract** — lists only the contracts that carry quality requirements (set under Cotton → Marketing). Selecting one adds the contract view, a fail count on each factor tile, the contract's requirement on each factor's chart, and a "% meets contract" column.
- **Exclude bales committed elsewhere** — on the contract panel, leaves out bales already in a CCC loan, sold, pooled, or assigned to another contract. Off by default.
- **Factor detail** — opens under the tiles when you tap one. For a measured factor (leaf, staple, micronaire, strength, uniformity, Rd, +b, trash, length, loan value) it is a histogram of every reading at the factor's own precision — micronaire by tenths, strength and uniformity by halves, staple by the 32nd — with each column colored by the crop year's price band (green premium, gray base, red discount; blue where the loan schedule doesn't price the factor). The average per bale, the pounds-weighted average, the median and the range sit at the top; the average is drawn as a dashed line. With a contract selected, the requirement is drawn as a solid black line (two lines for a micronaire range), the allowed range is washed green, and a line above the chart says how many eligible bales fail this factor and how many fail only this one. Tap a column to see those bales in the list.
- For a code factor (color grade, extraneous matter, remarks, color quadrant) the detail lists each code with a bar and its share; with a contract each code is marked ✓ allowed or ✕ fails.
- **Color grade grid** — inside the Color grade detail: the USDA color chart, rows are the grade (1 Good Middling through 7 Good Ordinary, 8 below grade), columns are White, Light Spotted, Spotted, Tinged and Yellow Stained. Darker cells hold more bales. With a contract selected, cells outside its allowed colors are hatched and marked ✕.
- **Comparison table** — one row per group with bales, pounds, each factor's average and its premium / base / discount shares, shaded by band; tap a heading to sort; the first column stays put when you scroll sideways on a phone.
- **Bale list** — every bale with its receipt, farm, field, variety, class date, the selected factors, loan value and disposition; search by PBI, receipt, farm, field or variety; sort by any column. With a contract selected each bale carries a result chip: Meets, Fails (with every failing factor and what it needed), Not eligible, or Not classed.
- **Export qualifying bales** — with a contract selected, a buyer-friendly Excel of the PBI list and full classing data for the bales that meet the spec: the classing data the contract says you provide.

## The contract view

- **Headline** — "N of M classed bales from eligible farms meet the spec (P%)", the lint pounds, how many bales are **not eligible** (their farm isn't on the contract's farm list) and how many are **not yet classed**.
- **Cap tracker** — qualifying bales against the contract's cap, plus **projected qualifying**: the current pass rate × the estimated bales (the contract's own estimate when it has one, otherwise Turnrow's expected lint ÷ 500). It is labeled an estimate because it is one.
- **Why bales fail** — the factors bales fail on, most common first, with **only this** counts: bales that would meet the spec but for that one factor. Those near misses are the bales worth asking the buyer to take at a discount. Tap a row to see them, or open that factor's tile to see where the failing readings sit against the contract line.

## How the numbers work

- Bales and pounds come from your gin receipts; grades come from the classing data imported on Bales & Grades, matched to bales by PBI number.
- A bale's **variety** is its field's planting for the crop year: a single-variety planting gives its bales that variety; a planting with several varieties shows "Mixed (A / B)" — Turnrow never guesses which bale is which. **Practice** is the planting's irrigated / dryland acres.
- **Price bands** come from the crop year's CCC loan premium and discount schedule (for 2026: micronaire 3.7–4.2 premium, 3.5–3.6 and 4.3–4.9 base, 3.4 and under or 5.0 and over discount; strength 29.0 and up premium, 26.0–28.9 base, under 26.0 discount; uniformity 82.0 and up premium, 80.0–81.9 base, under 80.0 discount; color, leaf and staple better than, at, or worse than the loan base 41-4-34). Readings compare at tenths, as USDA reports them. A crop year without its own schedule uses the newest one on file and says so.
- **Base or better** on the KPI strip counts bales at base or premium on every loan factor at once.
- **Averages** are per bale unless you pick Per lb; loan value in cents per pound is always pounds-weighted, so it matches a CCC loan calculation.
- **Loan value is shown above or below the base loan rate** (55¢ a pound for 2026) rather than as the full number: **+2.35¢** in green means the bale (or the average) is worth 2.35¢ a pound more than a base-grade bale in the loan, and **(1.20¢)** in red means 1.20¢ under. The factor detail still shows the average loan value itself next to the base rate, and its histogram draws a line at the base. In the Excel workbook the Bales tab keeps the classing loan value and adds a **Loan vs base** column beside it.
- **Meets spec**: every threshold is inclusive at the value written (staple 37 meets "37 and longer"; mic 4.7 meets "4.0–4.7"). A classed bale missing a reading the contract tests fails that factor. "Color 41 and better" means the white grades 11, 21, 31 and 41 — a light spotted 42 or 32 fails unless the contract's grid ticks it.
- In the Excel workbook the Summary and By Group tabs are formulas (COUNTIFS, AVERAGEIFS, SUMPRODUCT) over the Bales tab, and the Bales tab's Meets spec column reads the Contract Spec tab's blue threshold cells — change a threshold, add or remove a color code or an FSA farm number, and the counts move.

## Common questions

- **Why do some bales show no grades?** Their classing data hasn't been imported, or the classing rows didn't match a bale by PBI. Import the file on Bales & Grades and review the unmatched rows there.
- **A bale from a farm on the contract shows "not eligible".** The contract's farm list is matched by FSA number — check the farm's FSA number under Settings → Farms against the number on the contract's schedule.
- **Why does the contract list show nothing?** No cotton contract for this crop year carries quality requirements yet. Add them on Cotton → Marketing (Quality terms on the contract row).
- **Why is the projection different from the cap?** The cap is what the buyer committed to take; the projection is what the current pass rate says you'll have to offer.
- **I don't see this report at all.** The Cotton module may be turned off. An owner can turn it on under Settings → Organization.

## If something looks wrong

- If pounds look off, check the bale list on the gin receipt for that field.
- If a grade looks off, re-check the classing import on Bales & Grades.
- If a bale's variety or practice reads wrong, check the field's planting for the crop year under Yields.
- Anything else, contact support.
