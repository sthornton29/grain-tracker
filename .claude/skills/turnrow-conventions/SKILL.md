---
name: turnrow-conventions
description: Turnrow's design and code conventions — brand tokens, report-kit components, color semantics, number formatting, shared seams (exports, nav, entity scoping), multi-tenant table rules, and the session-end ritual. Use whenever building or modifying any UI, page, report, chart, export (Excel/PDF/print), nav entry, or new feature/table in this app — including small tweaks to existing screens.
---

# Turnrow conventions

Follow these whenever you touch UI, reports, exports, or add a feature. The
audience is farmer customers: plain language in all UI copy, no software
internals, no condescension; unfixable states say "contact support."

## Brand tokens

Defined in `tailwind.config.ts` — use the Tailwind classes, never raw hex in
components:

- `brand` = `#36B449` kelly green (sampled from the official Brand.png) — the
  chrome: buttons, active nav, links, accents. Hover/pressed pairs with
  `brand-deep` (`#256F35`, also link text — AA on white).
- `brand-dark` = `#0B4A24` forest — top nav bar, heading accents.
- Headings use Montserrat via `font-display` (`--font-display`, loaded in
  `app/layout.tsx`).
- Landing-tile gradients live in `lib/nav-links.ts` as STATIC full class
  strings (Tailwind JIT scans `lib/` for exactly this reason — don't build
  class names dynamically).

## Color semantics — data ≠ brand

Brand green is chrome only. DATA coloring stays on the stock Tailwind palette
so profit-green never blurs with brand-green. Use the `Tone` type and helpers
from `components/reports/report-kit.tsx` (`toneText`, `signedTone`) rather than
hand-picking colors:

- `favorable` = `text-green-700` (profit, gain, on-track)
- `unfavorable` = `text-red-700` (loss, shortfall)
- `warning` = `text-amber-700` (incomplete, needs attention)
- `muted` = `text-slate-400` (excluded / zero / n-a) · `neutral` = slate-700

## Report kit (`components/reports/report-kit.tsx`)

One consistent look for every report; presentation only — reports keep their
own data, calculations, and export wiring. Reach for these before writing
bespoke markup:

- `ReportHeader` — title + plain-English `filterSummary` ("2026 Crop Year ·
  All Entities · Corn") + `generatedAt`, with `<ExportBar/>` in `actions`.
- `ReportFilterBar` — the single horizontal filter row; collapses behind a
  "Filters" button with an active-count badge on phones/iPad portrait.
- `SummaryCards` / `SummaryCard` — the KPI card grid; values get a `tone`.
- `DataTable` — sticky header, zebra rows, right-aligned `tabular-nums`,
  `kind: 'subtotal' | 'total'` rows. For grouped/multi-row headers, hand-build
  the table with the exported class tokens (`theadCls`, `numCell`, `textCell`,
  `subtotalRowCls`, `grandTotalRowCls`) instead.
- `EmptyState` — what's missing + a link to where the user fixes it. Never
  render a blank table.
- `StackedBar` — proportional position bars (e.g. sold / hedged / unpriced).
- On-screen formatters: `fmtInt`, `fmtNum`, `fmtUsd`, `fmtPct`.

iPad-in-truck matters: touch targets and narrow-viewport behavior are not
optional polish.

## Number formatting

Commas (thousands separators) everywhere — acres, bushels, dollars, counts.
Negatives in parentheses, financial convention: `($1,234.56)`. Right-align
numbers with `tabular-nums`.

Canonical metric → format (the consistency contract in `lib/exports.ts`
`NumFmt` — same metric, same format, every report and export):

- crop year → `text` (never comma-grouped)
- bushels → `bu` (0 dec); pounds → `lbs` (0 dec) — unit-aware: grain is bu,
  cotton is lbs; never mix
- acres → `acres` (1 dec); yield bu/ac → `yield` (1 dec)
- $/bu → `price` ($, 2 dec)
- cotton prices are STORED in ¢/lb and DISPLAYED as $/lb at 4 decimals →
  `cents` (72.65 → `$0.7265`)
- whole-dollar totals (revenue, cost, indemnity, payments) → `usd0`;
  trading/hedging P&L keeps cents → `usd2`
- percentages → `pct0` / `pct1`; moisture → `dec1`; option premium → `dec2`

## Shared seams — never fork these

- **Row-cap-proof reads**: NEVER bare-`select()` a growing table (loads,
  splits, settlement lines, plantings, contracts, positions, per-bale cotton
  tables…) — the project silently caps requests at ~1,000 rows. Page every
  whole-table read through `lib/fetch-all-rows.ts` `fetchAllRows` with a
  stable `.order()` (usually `.order('id')` as the final tiebreak).
  `lib/growing-table-reads.test.ts` is the CI gate: it scans the source and
  fails on unpaginated reads of any `GROWING_TABLES` entry. A new table that
  grows per event or per year must be added to that list.

- **Exports**: every report export goes through `lib/exports.ts`. Build an
  `ExportPayload` and hand `buildPayload` to `components/export-bar.tsx`
  `<ExportBar/>` (Excel / PDF / Print). Excel cells stay REAL numbers with a
  numFmt (sortable/summable); PDF gets formatted strings; print uses
  `.print-area` / `.no-print` CSS in `app/globals.css`. Never write a
  one-off CSV/xlsx/pdf path.
- **Nav**: `lib/nav-links.ts` (`navLinksFor`) is the single source of truth —
  the top nav (`components/nav.tsx`) and the landing tiles (`app/page.tsx`)
  both render from it. New pages/roles change nav there only, and role
  restrictions (gin → Cotton only, viewer → Yields+Reports, agronomist →
  Yields) live there too. Every nav/reports route needs a `docs/help/` topic
  or `help:build` and CI fail.
- **Entity scoping**: reports never filter nullable `entity_id` columns
  directly — contracts/futures/options are mostly null-entity or held by the
  marketing-agent entity, and strict filtering zeroes out sales. Go through
  `lib/entity-scope.ts` (`buildEntityScope`, `attribution()` for pro-rata
  flow-down); pass `grantedEntityIds` for viewers (052) — it fails closed.

## Multi-tenant rules for new tables (053/054+)

Every new tenant table must, in its own migration:

- add `org_id` NOT NULL FK → organizations with
  `default coalesce(current_org_id(), default_org_id())` (the 054 stamping
  default) plus an `(org_id)` index (composite with the hot filter column
  where relevant);
- write the FULL policy stack inline: permissive authed-all, RESTRICTIVE
  `*_org_isolation` (`org_id = current_org_id()` for select and every write),
  the 042 gin block, 052 viewer write-blocks (+ row-scoping if entity/field-
  keyed, or a read block if financial), and 061 agronomist write-blocks —
  plus 061's `AGRONOMIST_READABLE_TABLES` allowlist entry + shape test if it's
  part of the Yields read surface;
- add the table to the tenant arrays in 053/054 and `verify_053.sql` /
  `verify_054.sql`;
- scope any unique constraints per-org (`(org_id, …)`);
- service-role code paths must scope `.eq('org_id', …)` explicitly (they
  bypass RLS). Anything guarded by `app_role()` must also require
  `auth.uid() is not null`.

Recent migrations (058, 062, 067, 069) are the templates — copy their policy
blocks.

## Session-end ritual

When a session changes user-facing behavior: regenerate `PROJECT_SUMMARY.md`,
update the affected `docs/help/` pages (bump each `updated:` date; plain
farmer language, no internals), review `docs/help/_limitations.md` if a
capability changed, then run `npm run help:build` and commit its outputs —
CI enforces help coverage, and topic dates are customer-visible.
