-- Repair (2026-11-17): split-load portions whose stored dry bushels no longer
-- match their load's moisture.
--
-- A split load stores each field's bushels when it is saved. When a settlement
-- later filled in a moisture the ticket never had, the load itself shrank (a
-- whole load's dry bushels are worked out on the fly) but its stored portions
-- did not — so the fields kept unshrunk bushels. The save path is fixed
-- (lib/load-splits reshrinkSplits, called from the settlement save); this
-- brings the rows already saved in line.
--
-- Known case: ticket 1-47-0502289, 9/25/2026, soybeans at 13.4% on a 13% base,
-- split over Low Ussery / Spring Creek E&W / Summerwood:
--   170.33 -> 169.55, 357.33 -> 355.69, 444.33 -> 442.29   (4.47 bu in all)
--
-- Same shrink as the app (lib/shrink computeBushels): wet = net lb / lb per bu;
-- dry = wet when moisture <= base, else wet x (100 - moisture) / (100 - base);
-- rounded to 2 decimals as a split portion is stored. A parent load with a
-- manual dry-bushel override is left alone (the app never redistributes an
-- override over its portions).
--
-- STEP 1 — look first (read-only). Run this SELECT on its own.
select o.name as org, l.date, l.ticket_number, c.name as crop, l.moisture, c.base_moisture_pct as base,
       f.name_or_number as field, s.net_weight, s.dry_bushels as stored,
       round(((s.net_weight / c.base_lb_per_bushel)
              * case when l.moisture > c.base_moisture_pct then (100 - l.moisture) / (100 - c.base_moisture_pct) else 1 end)::numeric, 2) as corrected
from load_splits s
join loads l on l.id = s.load_id
join crops c on c.id = l.crop_id
join organizations o on o.id = s.org_id
left join fields f on f.id = s.field_id
where l.moisture is not null
  and l.dry_bushels_override is null
  and c.base_lb_per_bushel > 0
  and c.base_moisture_pct is not null
  and s.net_weight is not null
  and s.dry_bushels is not null
  and abs(s.dry_bushels - round(((s.net_weight / c.base_lb_per_bushel)
              * case when l.moisture > c.base_moisture_pct then (100 - l.moisture) / (100 - c.base_moisture_pct) else 1 end)::numeric, 2)) > 0.011
order by o.name, l.date, l.ticket_number, f.name_or_number;

-- STEP 2 — the correction. Run only after STEP 1 lists what you expect.
-- update load_splits s
-- set dry_bushels = round(((s.net_weight / c.base_lb_per_bushel)
--                    * case when l.moisture > c.base_moisture_pct then (100 - l.moisture) / (100 - c.base_moisture_pct) else 1 end)::numeric, 2)
-- from loads l, crops c
-- where l.id = s.load_id and c.id = l.crop_id
--   and l.moisture is not null
--   and l.dry_bushels_override is null
--   and c.base_lb_per_bushel > 0
--   and c.base_moisture_pct is not null
--   and s.net_weight is not null
--   and s.dry_bushels is not null
--   and abs(s.dry_bushels - round(((s.net_weight / c.base_lb_per_bushel)
--                    * case when l.moisture > c.base_moisture_pct then (100 - l.moisture) / (100 - c.base_moisture_pct) else 1 end)::numeric, 2)) > 0.011;
