-- 072 — Landowner-share scopes for lease-income projections.
--
-- Two new per-share opt-ins, both DEFAULT FALSE so no existing share changes
-- until the farmer flips the toggle on /settings/shares:
--   * share_projected_prices — the operation's projected average price per
--     crop (one aggregate number; never contracts, hedges, or the
--     priced/unpriced split). Serves GET /api/partner/v1/marketing-prices.
--   * share_projected_yields — pre-harvest projected yield per SHARED field
--     x crop (distinct from include_yields, which covers harvested actuals).
--     Serves GET /api/partner/v1/projected-yields.
--
-- Scope changes take effect on the next API call: lib/partner-api-server.ts
-- resolvePartnerAccess re-reads the share row per request (no caching).
-- No policy changes — 070's partner_shares_org policy covers the columns.
-- Idempotent: safe to re-run.

alter table public.partner_shares
  add column if not exists share_projected_prices boolean not null default false;
alter table public.partner_shares
  add column if not exists share_projected_yields boolean not null default false;
