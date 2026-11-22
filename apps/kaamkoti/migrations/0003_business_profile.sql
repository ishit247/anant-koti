-- A business's own copy of its trade template, and its price list (docs/architecture.md 5.3). Copied at onboarding,
-- then edited freely: a later template version never changes what a business already has.
create table kk.business_profile (
  business_id uuid primary key references tenancy.business (id),
  -- Free text, not a foreign key: a business may start from a template that is later retired, or from none.
  trade_key text not null check (trade_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  about text not null default '' check (length(about) <= 2000),
  service_area text not null default '' check (length(service_area) <= 500),
  checklist jsonb not null check (jsonb_typeof(checklist) = 'array'),
  terms text not null check (length(terms) <= 4000),
  created_at timestamptz not null default now()
);

create table kk.catalogue_item (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  name text not null check (length(name) between 1 and 120),
  unit text not null check (unit in ('job', 'hour', 'unit', 'sq_ft', 'metre', 'visit')),
  unit_price_minor bigint not null check (unit_price_minor between 0 and 100000000),
  tax_rate_bp integer not null check (tax_rate_bp between 0 and 10000),
  active boolean not null default true,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  -- Target of the composite foreign key from job_task: a task can only name its own business's item.
  unique (business_id, id)
);
-- The price list is always read for one business, in display order; this also indexes the business_id foreign key.
create index catalogue_item_business_position on kk.catalogue_item (business_id, position);

alter table kk.business_profile enable row level security;
create policy tenant on kk.business_profile
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
alter table kk.catalogue_item enable row level security;
create policy tenant on kk.catalogue_item
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  -- No delete: a price an old quote used is retired with active = false, not removed.
  execute format('grant select, insert, update on kk.business_profile, kk.catalogue_item to %I', runtime);
end $$;
