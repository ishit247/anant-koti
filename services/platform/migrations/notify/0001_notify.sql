-- Notify's messages (docs/architecture.md 9.2): one row per message an app asked for, kept for retries and
-- status. The row is reached only through notify's own code, by id, with no tenant context (the delivery job
-- runs for every business), so like outbox.message it has no RLS. The recipient and variables are personal data
-- and never leave this table: logs and audit events carry the id and template only.
create schema notify;

create table notify.message (
  id uuid primary key default gen_random_uuid(),
  -- The app's signed client id, which also names its template set.
  product text not null check (length(product) between 1 and 40),
  business_id uuid not null,
  template text not null check (template ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and length(template) <= 80),
  -- Null when the message has no address on any channel there is (status no_channel).
  channel text check (channel in ('email', 'whatsapp')),
  recipient jsonb not null check (jsonb_typeof(recipient) = 'object'),
  vars jsonb not null check (jsonb_typeof(vars) = 'object'),
  -- delivered and a failure after sent come from the provider's status webhook (WhatsApp only).
  status text not null check (status in ('queued', 'sent', 'delivered', 'failed', 'no_channel')),
  -- Send attempts made; set when the message is sent or given up on.
  attempts int not null default 0 check (attempts >= 0),
  -- The provider's id of the sent message (Meta's wamid), which its status webhook names.
  provider_id text unique check (length(provider_id) between 1 and 200),
  created_at timestamptz not null default now(),
  -- When it left (sent) or was given up on (failed).
  finished_at timestamptz,
  check ((channel is null) = (status = 'no_channel')),
  check ((finished_at is null) = (status in ('queued', 'no_channel'))),
  check (status <> 'delivered' or channel = 'whatsapp')
);
-- The 30-day purge reads by age.
create index message_created on notify.message (created_at);

-- WhatsApp messages each business has used in a calendar month (UTC), per product (architecture 9.2). A message
-- counts when it is queued for WhatsApp; the limit is platform config until plans carry it (5.1), with top-ups
-- in 5.2. Kept after the purge: it is a count, with no personal data.
create table notify.quota (
  product text not null check (length(product) between 1 and 40),
  business_id uuid not null,
  -- The first day of the month.
  month date not null check (extract(day from month) = 1),
  used int not null check (used >= 0),
  -- The owner has been told this month's messages ran out (3.3d): once a month, on the first message lost to it.
  owner_told boolean not null default false,
  primary key (product, business_id, month)
);

-- The purge (architecture 9.2), run daily by notify's scheduled job: the one delete there is. The runtime role
-- has no DELETE on the table, so it can remove messages only by age, through this function, never by id.
create function notify.purge_messages() returns bigint
  language sql security definer set search_path = pg_catalog
as $$
  with gone as (delete from notify.message where created_at < now() - interval '30 days' returning 1)
  select count(*) from gone
$$;
revoke execute on function notify.purge_messages() from public;

-- A GRANT never withholds, so the rights the runtime role must not have are revoked explicitly.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema notify to %I', runtime);
  execute format('grant select, insert, update on notify.message to %I', runtime);
  execute format('revoke delete, truncate on notify.message from %I', runtime);
  execute format('grant select, insert, update on notify.quota to %I', runtime);
  execute format('revoke delete, truncate on notify.quota from %I', runtime);
  execute format('grant execute on function notify.purge_messages() to %I', runtime);
end $$;
