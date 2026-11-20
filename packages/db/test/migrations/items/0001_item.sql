-- Fixture: one tenant table with the RLS policy from docs/architecture.md 4.2, granted to the runtime role.
create schema fx;
grant usage on schema fx to kaamkoti_app;
create table fx.item (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  label text not null
);
alter table fx.item enable row level security;
create policy tenant on fx.item
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
grant select, insert, update on fx.item to kaamkoti_app;
