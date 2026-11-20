-- The audit log (docs/architecture.md 11): append-only for the runtime role. No foreign key to the business,
-- because the platform database has an audit schema and no tenancy schema.
create schema audit;

create table audit.event (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  actor_kind text not null check (actor_kind in ('member', 'customer', 'system', 'platform')),
  -- The system has no id; every other actor has one.
  actor_id uuid check ((actor_kind = 'system') = (actor_id is null)),
  -- Dotted lower-case, e.g. payment.recorded.
  action text not null check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and length(action) <= 80),
  entity text not null check (entity ~ '^[a-z][a-z0-9_]*$' and length(entity) <= 40),
  entity_id uuid not null,
  -- Ids and amounts only, never names, phones or free text.
  data jsonb not null default '{}' check (jsonb_typeof(data) = 'object'),
  at timestamptz not null default now()
);
create index event_business_at on audit.event (business_id, at);

alter table audit.event enable row level security;
create policy tenant on audit.event
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- A GRANT never withholds: if default privileges ever gave the runtime role more, the narrow grant would
-- restrict nothing. So the rights it must not have are revoked explicitly, and a test proves they are absent.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema audit to %I', runtime);
  execute format('grant select, insert on audit.event to %I', runtime);
  execute format('revoke update, delete, truncate on audit.event from %I', runtime);
end $$;
