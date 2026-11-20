-- Transactional outbox and idempotent inbox (docs/architecture.md 9.1). Both serve the whole process, not one
-- tenant: the sender writes a message inside the business transaction, and the worker delivers it with no tenant
-- context. A payload carries the business id it concerns, so these tables have no RLS.
create schema outbox;

create table outbox.message (
  id uuid primary key default gen_random_uuid(),
  -- Dotted lower-case, e.g. notify.send; becomes the path /internal/v1/<topic>.
  topic text not null check (topic ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and length(topic) <= 80),
  -- Chosen by the sender, unique per sender; the receiver records it so a redelivery takes effect once.
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 200),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
-- What is still to deliver, oldest first: the backlog a stuck receiver leaves behind.
create index message_undelivered on outbox.message (created_at) where delivered_at is null;

create table outbox.inbox (
  -- The verified sender: a service client id, or a payment provider for webhooks.
  source text not null check (length(source) between 1 and 40),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  received_at timestamptz not null default now(),
  primary key (source, idempotency_key)
);

-- A GRANT never withholds, so the rights the runtime role must not have are revoked explicitly.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema outbox to %I', runtime);
  execute format('grant select, insert, update on outbox.message to %I', runtime);
  execute format('grant select, insert on outbox.inbox to %I', runtime);
  execute format('revoke delete, truncate on outbox.message from %I', runtime);
  execute format('revoke update, delete, truncate on outbox.inbox from %I', runtime);
end $$;
