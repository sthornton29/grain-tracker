-- Repair of the 10/12/2026 StoneX import (account 490JP046) — ONE transaction.
-- Run ONLY after Stuart's OK:  npx supabase db query --linked -f supabase/repair_stonex_1012.sql
--
-- What production holds today (read 2026-10-13, nothing changed yet):
--   roll group 3f14893f-1355-4a1e-a5c0-ca27b1da2f9d
--     DEC 26 Cotton short 10 @ 72.65 (fb7b7496…)  closed 10/12 @ 80.45739, realized -39,036.95, commission 0
--     DEC 26 Cotton short 13 @ 84.40 (7ea3adab…)  closed 10/12 @ 80.45739, realized +25,626.97, commission 0
--     MAR 27 Cotton short 12 @ 83.64 (94e6fa9b…)  roll_open, rolled_from fb7b7496, commission 0
--   plain opens (no roll group, no lineage), all import_statement_date 10/12, commission 0:
--     MAR 27 Cotton short 3 @ 83.63 (8be78af7…), 3 @ 83.65 (82f788aa…), 3 @ 83.67 (ac1fdd2f…), 2 @ 83.68 (9fbef454…)
-- So MAR 27 = 23 short in 5 lots already — there are NO duplicate rows to delete. What is wrong:
--   (1) four of the five MAR fills are not part of the roll (effective price would weight only the 12-lot);
--   (2) the $1,063.06 of commission & fees was never booked ($531.53 per side);
--   (3) realized was rounded from the AVERAGE close: -39,036.95 + 25,626.97 = -13,409.98 (statement: -13,410.00).
--
-- The repair:
--   a. link the four plain MAR lots into the roll group (roll_group_id + rolled_from = the 10-lot anchor,
--      the same linkage hedge_execute_roll writes for every open leg since 0095);
--   b. book the fees: close side 531.53 split 10/23 : 13/23 over the two DEC lots (231.10 / 300.43);
--      open side 531.53 split 3/12/3/3/2 of 23 over the five MAR lots (69.33 / 277.32 / 69.33 / 69.33 / 46.22);
--   c. realized per lot from the exact average 80.4573913: -39,036.96 and +25,626.96 (sum -13,410.00).
-- Every update is logged by the ledger trigger as source 'manual' with the note below.
--
-- Effective entry on the MAR leg afterwards = DEC average 79.29130 + roll spread 3.19000 = 82.48130 ¢/lb.
-- NOT touched (not on the statement; report to Stuart): DEC 26 Cotton 4 @ 72.30 open (bed856f9…),
-- Corn DEC 26 12 short open, Soybeans NOV 26 8 short open (the statement shows 2).

begin;

select set_config('turnrow.hedge_event_source', 'manual', true);
select set_config('turnrow.hedge_statement_date', '2026-10-12', true);
select set_config('turnrow.hedge_statement_ref', 'StoneX', true);
select set_config('turnrow.hedge_event_note', 'repair of the 10/12 roll import: all five MAR 27 fills linked into the roll, fees booked ($1,063.06), realized rounded per lot', true);

-- a + b (open side): link the four plain MAR lots and spread the open-side fee over all five.
update public.futures_positions set
  roll_group_id = '3f14893f-1355-4a1e-a5c0-ca27b1da2f9d',
  rolled_from_position_id = 'fb7b7496-9d7c-41fd-a539-b070413ee935',
  commission = 69.33
where id = '8be78af7-c4fd-4171-8f9f-447b609cee48' and contract_month = 'MAR 27' and num_contracts = 3 and trade_price = 83.63;
update public.futures_positions set
  roll_group_id = '3f14893f-1355-4a1e-a5c0-ca27b1da2f9d',
  rolled_from_position_id = 'fb7b7496-9d7c-41fd-a539-b070413ee935',
  commission = 69.33
where id = '82f788aa-c368-4a09-8df4-7deaa965ca3a' and contract_month = 'MAR 27' and num_contracts = 3 and trade_price = 83.65;
update public.futures_positions set
  roll_group_id = '3f14893f-1355-4a1e-a5c0-ca27b1da2f9d',
  rolled_from_position_id = 'fb7b7496-9d7c-41fd-a539-b070413ee935',
  commission = 69.33
where id = 'ac1fdd2f-06ae-412c-9b0b-56d00a35e3f4' and contract_month = 'MAR 27' and num_contracts = 3 and trade_price = 83.67;
update public.futures_positions set
  roll_group_id = '3f14893f-1355-4a1e-a5c0-ca27b1da2f9d',
  rolled_from_position_id = 'fb7b7496-9d7c-41fd-a539-b070413ee935',
  commission = 46.22
where id = '9fbef454-9fea-4001-8912-a6327029fe87' and contract_month = 'MAR 27' and num_contracts = 2 and trade_price = 83.68;
update public.futures_positions set commission = 277.32
where id = '94e6fa9b-4dea-44e7-800a-db66b19cc3b7' and contract_month = 'MAR 27' and num_contracts = 12 and trade_price = 83.64;

-- b (close side) + c: fees and exact per-lot realized on the two DEC legs.
update public.futures_positions set commission = 231.10, realized_pnl = -39036.96
where id = 'fb7b7496-9d7c-41fd-a539-b070413ee935' and status = 'closed' and num_contracts = 10;
update public.futures_positions set commission = 300.43, realized_pnl = 25626.96
where id = '7ea3adab-7914-4b5f-9b33-e9b29dee5e48' and status = 'closed' and num_contracts = 13;

-- After-state checks (the last statement's rows are what db query prints).
select
  (select json_agg(json_build_object('month', contract_month, 'side', side, 'n', num_contracts, 'price', trade_price, 'in_roll', roll_group_id is not null, 'from_anchor', rolled_from_position_id = 'fb7b7496-9d7c-41fd-a539-b070413ee935', 'commission', commission) order by trade_price)
     from public.futures_positions where commodity = 'Cotton' and contract_month = 'MAR 27' and status = 'open') as mar27_lots,
  (select sum(num_contracts) from public.futures_positions where commodity = 'Cotton' and contract_month = 'MAR 27' and status = 'open') as mar27_short,
  (select round(sum(num_contracts * trade_price) / sum(num_contracts), 5) from public.futures_positions where commodity = 'Cotton' and contract_month = 'MAR 27' and status = 'open') as mar27_avg,
  (select count(*) from public.futures_positions where commodity = 'Cotton' and contract_month = 'DEC 26' and status = 'open' and roll_group_id is not null) as dec26_open_in_roll,
  (select sum(realized_pnl) from public.futures_positions where roll_group_id = '3f14893f-1355-4a1e-a5c0-ca27b1da2f9d' and status = 'closed') as dec_realized_total,
  (select sum(commission) from public.futures_positions where roll_group_id = '3f14893f-1355-4a1e-a5c0-ca27b1da2f9d') as roll_fees_total,
  (select round(sum(num_contracts * trade_price) / sum(num_contracts), 5) from public.futures_positions where roll_group_id = '3f14893f-1355-4a1e-a5c0-ca27b1da2f9d' and status = 'closed') as dec_avg_entry,
  (select round(sum(num_contracts * close_price) / sum(num_contracts), 5) from public.futures_positions where roll_group_id = '3f14893f-1355-4a1e-a5c0-ca27b1da2f9d' and status = 'closed') as dec_avg_close,
  (select json_agg(json_build_object('commodity', commodity, 'month', contract_month, 'side', side, 'n', n) order by commodity, contract_month)
     from (select commodity, contract_month, side, sum(num_contracts) n from public.futures_positions where status = 'open' group by 1, 2, 3) x) as open_positions,
  -- Per open month, OTE at the statement's 10/12 closes (corn 4.9725, soybeans 12.8775, wheat 6.95, cotton 83.81; shorts: (entry - close) x size).
  -- The statement's own lots sum to 73,475 - 8,425 + 6,900 - 1,870 = 70,080.00. Months/lots NOT on the statement
  -- (Corn DEC 26 12 @ 4.685, Cotton DEC 26 4 @ 72.30, Soybeans NOV 26 6 @ 10.55) are listed so Stuart can decide about them.
  (select json_agg(json_build_object('commodity', commodity, 'month', contract_month, 'n', n, 'ote', ote) order by commodity, contract_month)
     from (select commodity, contract_month, sum(num_contracts) n,
                  round(sum(case commodity when 'Corn' then (trade_price - 4.9725) * 5000 * num_contracts
                                           when 'Soybeans' then (trade_price - 12.8775) * 5000 * num_contracts
                                           when 'Chicago Wheat' then (trade_price - 6.95) * 5000 * num_contracts
                                           when 'Cotton' then (trade_price - 83.81) * 500 * num_contracts end), 2) ote
             from public.futures_positions where status = 'open' and side = 'short' group by 1, 2) m) as ote_by_month_at_1012_closes;

commit;
