-- 0099: program-year payees + FSA payment statements (2026-10-28).
-- Applied with `npx supabase db push --linked` (supabase/migrations/, like 0093 to 0098).
--
-- Two things the October 2026 ARC/PLC payments showed the app could not say:
--
-- 1. WHO WAS PAID for a program year. Government payments roll up through
--    farms.entity_id — the farm's CURRENT entity — but the payee of a program
--    year's ARC/PLC is whoever operated the farm that year (Martin Farm was
--    paid for program year 2025; View Celeste / Two Seasons operate the same
--    farms for 2026). farm_program_payees holds the explicit payee per farm ×
--    program year; lib/program-payee.ts payeeEntityFor(farm, programYear)
--    is the ONE rule (explicit row wins, else farms.entity_id) that every
--    consumer — the Tracker, payment limits, Cash Flow, Revenue Projections,
--    Income Sensitivity, Ask Turnrow, the exports — reads through.
--
-- 2. WHAT WAS ACTUALLY PAID. fsa_payment_statements / fsa_payment_lines /
--    fsa_payment_crop_amounts hold the USDA/FSA "Payment Statement" (the
--    national layout printed by the FSA National Office for every program)
--    read by the document reader: one statement, its payment blocks (one FSA
--    Payment ID each — unique per org, so a re-upload is "already recorded"),
--    and each block's crop amounts. ARC/PLC crop amounts are the ACTUAL for
--    farm × commodity × program year (lib/fsa-actuals.ts merges them over the
--    projections — no double counting); non-ARC/PLC programs land in
--    other_government_payments linked back by fsa_payment_line_id.
--
-- account_last4 is the ONLY bank detail kept (the statement prints the
-- account's last four digits; the reader is told to extract nothing more).
--
-- Policy stack (the 0097 template): permissive authed-all; RESTRICTIVE 053/054
-- org isolation; 042/044 producer-only (gin blocked on every verb); 052 viewer
-- read scoped to granted farms / entities + write-blocked; 061 agronomist
-- blocked on every verb (financial, never a Yields read). All four tables are
-- added to the tenant arrays in 053/054 and verify_053/054.

-- 1. farm_program_payees --------------------------------------------------------

create table if not exists public.farm_program_payees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  farm_id uuid not null references public.farms(id) on delete cascade,
  program_year integer not null check (program_year between 2000 and 2100),
  entity_id uuid not null references public.entities(id) on delete cascade,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint farm_program_payees_one_per_year unique (org_id, farm_id, program_year)
);
create index if not exists farm_program_payees_org_year_idx on public.farm_program_payees (org_id, program_year);
create index if not exists farm_program_payees_org_entity_idx on public.farm_program_payees (org_id, entity_id);

comment on table public.farm_program_payees is
  'The entity paid for a farm''s government payments in ONE program year (ARC/PLC program year N is paid October N+1). No row = the farm''s current entity (farms.entity_id). lib/program-payee.ts payeeEntityFor is the one rule.';

drop trigger if exists farm_program_payees_set_updated_at on public.farm_program_payees;
create trigger farm_program_payees_set_updated_at
  before update on public.farm_program_payees
  for each row execute function public.set_updated_at();

alter table public.farm_program_payees enable row level security;

-- 2. fsa_payment_statements -----------------------------------------------------

create table if not exists public.fsa_payment_statements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  statement_date date not null,
  office_name text,
  office_address text,
  office_phone text,
  payee_name text not null,
  payee_address text,
  payee_entity_id uuid references public.entities(id) on delete set null,
  gross_payment numeric(14,2) not null default 0,
  deductions numeric(14,2) not null default 0,
  net_payment numeric(14,2) not null default 0,
  document_url text,
  document_path text,
  page_count integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fsa_payment_statements_org_date_idx on public.fsa_payment_statements (org_id, statement_date);
create index if not exists fsa_payment_statements_org_payee_idx on public.fsa_payment_statements (org_id, payee_entity_id);

comment on table public.fsa_payment_statements is
  'A USDA/FSA Payment Statement (the national layout, every FSA program): county office, payee, statement date, the Payment Summary (gross / deductions / net), the stored PDF. Its blocks are fsa_payment_lines.';

drop trigger if exists fsa_payment_statements_set_updated_at on public.fsa_payment_statements;
create trigger fsa_payment_statements_set_updated_at
  before update on public.fsa_payment_statements
  for each row execute function public.set_updated_at();

alter table public.fsa_payment_statements enable row level security;

-- 3. fsa_payment_lines ----------------------------------------------------------

create table if not exists public.fsa_payment_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  statement_id uuid not null references public.fsa_payment_statements(id) on delete cascade,
  fsa_payment_id text not null,
  transaction_control_number text,
  program_code text not null default 'OTHER' check (program_code in ('PLC', 'ARC_CO', 'ARC_IC', 'OTHER')),
  program_name_raw text not null,
  program_year integer check (program_year is null or program_year between 2000 and 2100),
  farm_id uuid references public.farms(id) on delete set null,
  fsa_farm_number text,
  gross_payment numeric(14,2) not null default 0,
  deductions numeric(14,2) not null default 0,
  deduction_detail jsonb,
  net_payment numeric(14,2) not null default 0,
  payment_method text,
  bank_name text,
  account_last4 text check (account_last4 is null or account_last4 ~ '^[0-9]{1,4}$'),
  payment_date date,
  sequester_pct numeric(6,4),
  notes text,
  page_number integer,
  created_at timestamptz not null default now(),
  constraint fsa_payment_lines_one_per_payment_id unique (org_id, fsa_payment_id)
);
create index if not exists fsa_payment_lines_org_statement_idx on public.fsa_payment_lines (org_id, statement_id);
create index if not exists fsa_payment_lines_org_farm_year_idx on public.fsa_payment_lines (org_id, farm_id, program_year);
create index if not exists fsa_payment_lines_org_date_idx on public.fsa_payment_lines (org_id, payment_date);

comment on table public.fsa_payment_lines is
  'One payment block of an FSA Payment Statement: FSA Payment ID (unique per org — a re-upload is "already recorded"), program (PLC / ARC_CO / ARC_IC / OTHER + the printed title), program year, FSA farm (matched by farm number; the raw number is kept when unmatched), gross / deductions / net, ACH detail (bank + last 4 only), payment date, the sequester % from the notes.';
comment on column public.fsa_payment_lines.account_last4 is 'The last four digits printed on the statement — never more of the account number.';

alter table public.fsa_payment_lines enable row level security;

-- 4. fsa_payment_crop_amounts ---------------------------------------------------

create table if not exists public.fsa_payment_crop_amounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id)
    default coalesce(public.current_org_id(), public.default_org_id()),
  line_id uuid not null references public.fsa_payment_lines(id) on delete cascade,
  commodity_id uuid references public.covered_commodities(id) on delete set null,
  raw_crop text not null,
  amount numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists fsa_payment_crop_amounts_org_line_idx on public.fsa_payment_crop_amounts (org_id, line_id);
create index if not exists fsa_payment_crop_amounts_org_commodity_idx on public.fsa_payment_crop_amounts (org_id, commodity_id);

comment on table public.fsa_payment_crop_amounts is
  'The "Crop and Payment Amount Detail" of a payment block: one row per crop (SEED COTTON : $8,624.00), mapped to a covered commodity. For ARC/PLC lines these are the ACTUAL payment per farm × commodity × program year.';

alter table public.fsa_payment_crop_amounts enable row level security;

-- 5. other_government_payments ← the statement line it came from -------------

alter table public.other_government_payments
  add column if not exists fsa_payment_line_id uuid references public.fsa_payment_lines(id) on delete cascade;
create unique index if not exists other_government_payments_fsa_line_uidx
  on public.other_government_payments (fsa_payment_line_id) where fsa_payment_line_id is not null;
comment on column public.other_government_payments.fsa_payment_line_id is
  '0099: set when the payment was recorded from an FSA Payment Statement block (non-ARC/PLC programs); deleting the statement removes it.';

-- 6. Policies -----------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['farm_program_payees', 'fsa_payment_statements', 'fsa_payment_lines', 'fsa_payment_crop_amounts'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_all') then
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t || '_all', t);
    end if;
    -- 053/054: org isolation on every verb.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
    end if;
    -- 042/044: producer-only — the gin role never sees government payments.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_owner_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''gin'') with check (public.app_role() <> ''gin'')', t || '_owner_only', t);
    end if;
    -- 052: viewers never write.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_viewer_block_ins') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.app_role() <> ''viewer'')', t || '_viewer_block_ins', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_upd', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.app_role() <> ''viewer'')', t || '_viewer_block_del', t);
    end if;
    -- 061: the agronomist never reads or writes payments.
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_agronomist_block_all') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.app_role() <> ''agronomist'') with check (public.app_role() <> ''agronomist'')', t || '_agronomist_block_all', t);
    end if;
  end loop;
end $$;

-- 052 viewer read scope: a viewer sees the payee rows of granted farms /
-- entities, the statements and lines that pay a granted farm (or are paid to
-- a granted entity), and the crop amounts of lines they can see (the inner
-- select runs under the viewer's own RLS on fsa_payment_lines).
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'farm_program_payees' and policyname = 'farm_program_payees_viewer_scope') then
    create policy farm_program_payees_viewer_scope on public.farm_program_payees as restrictive for select to authenticated
      using (public.app_role() <> 'viewer'
             or farm_id in (select public.viewer_farm_ids())
             or entity_id in (select public.viewer_entity_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'fsa_payment_lines' and policyname = 'fsa_payment_lines_viewer_scope') then
    create policy fsa_payment_lines_viewer_scope on public.fsa_payment_lines as restrictive for select to authenticated
      using (public.app_role() <> 'viewer'
             or farm_id in (select public.viewer_farm_ids())
             or statement_id in (select s.id from public.fsa_payment_statements s where s.payee_entity_id in (select public.viewer_entity_ids())));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'fsa_payment_statements' and policyname = 'fsa_payment_statements_viewer_scope') then
    create policy fsa_payment_statements_viewer_scope on public.fsa_payment_statements as restrictive for select to authenticated
      using (public.app_role() <> 'viewer'
             or payee_entity_id in (select public.viewer_entity_ids())
             or id in (select l.statement_id from public.fsa_payment_lines l where l.farm_id in (select public.viewer_farm_ids())));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'fsa_payment_crop_amounts' and policyname = 'fsa_payment_crop_amounts_viewer_scope') then
    create policy fsa_payment_crop_amounts_viewer_scope on public.fsa_payment_crop_amounts as restrictive for select to authenticated
      using (public.app_role() <> 'viewer' or line_id in (select id from public.fsa_payment_lines));
  end if;
end $$;
