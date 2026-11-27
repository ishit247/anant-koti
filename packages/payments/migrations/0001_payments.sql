-- Customer payments to a business (docs/architecture.md 8, 12). Money goes straight to the business's own provider
-- account, never through us. A link is what the customer pays through; a payment is money received, online (only
-- from a verified webhook) or cash (recorded by a member). Webhook deduplication uses outbox.inbox, source
-- 'razorpay'. No foreign keys to tenancy, as in storage: the business id is the RLS key and the app's own rows
-- point here with composite keys.
create schema payments;

-- One provider account per business. The secrets are AES-256-GCM sealed by the app (key from config), with the
-- business id and field name as associated data, so a sealed value copied into another row does not open.
create table payments.account (
  business_id uuid primary key,
  provider text not null check (provider in ('razorpay')),
  key_id text not null check (key_id ~ '^rzp_(test|live)_[A-Za-z0-9]{6,40}$'),
  key_secret bytea not null check (length(key_secret) > 28),
  webhook_secret bytea not null check (length(webhook_secret) > 28),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table payments.link (
  -- Also the provider's reference_id, so their dashboard and our row name each other.
  id uuid primary key,
  business_id uuid not null,
  -- What the app is collecting for (a job) and why (its own word, e.g. deposit).
  subject_id uuid not null,
  purpose text not null check (purpose ~ '^[a-z][a-z_]{0,39}$'),
  provider text not null check (provider in ('razorpay')),
  provider_link_id text not null check (provider_link_id ~ '^plink_[A-Za-z0-9]{6,40}$'),
  url text not null check (url ~ '^https://' and length(url) <= 300),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  accept_partial boolean not null,
  -- Sum of payments recorded against the link; status follows from it, or from the provider closing the link.
  amount_paid_minor bigint not null default 0 check (amount_paid_minor >= 0),
  status text not null default 'created'
    check (status in ('created', 'partially_paid', 'paid', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_link_id),
  unique (business_id, id)
);
-- A subject's links, for the job page, and the one open link per purpose, so a repeated request reuses it.
create index link_subject on payments.link (business_id, subject_id);
create unique index link_open on payments.link (business_id, subject_id, purpose)
  where status in ('created', 'partially_paid');

create table payments.payment (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  subject_id uuid not null,
  method text not null check (method in ('online', 'cash')),
  link_id uuid,
  provider_payment_id text check (provider_payment_id ~ '^pay_[A-Za-z0-9]{6,40}$'),
  -- As the provider reports it (upi, card, netbanking …); display only.
  provider_method text check (length(provider_method) <= 40),
  -- The member who recorded a cash payment.
  recorded_by uuid,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  received_at timestamptz not null default now(),
  foreign key (business_id, link_id) references payments.link (business_id, id),
  -- A replayed webhook, whatever its headers, names a payment already recorded.
  unique (business_id, provider_payment_id),
  unique (business_id, id),
  check (
    (method = 'online' and link_id is not null and provider_payment_id is not null and recorded_by is null)
    or (method = 'cash' and link_id is null and provider_payment_id is null and provider_method is null
        and recorded_by is not null)
  )
);
create index payment_subject on payments.payment (business_id, subject_id);
create index payment_link on payments.payment (business_id, link_id) where link_id is not null;

do $$
declare
  t text;
begin
  foreach t in array array['account', 'link', 'payment'] loop
    execute format('alter table payments.%I enable row level security', t);
    execute format(
      'create policy tenant on payments.%I
         using (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)
         with check (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)', t);
  end loop;
end $$;

-- A GRANT never withholds, so what the runtime role must not do is revoked explicitly. A payment, once recorded,
-- never changes.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema payments to %I', runtime);
  execute format('grant select, insert, update on payments.account, payments.link to %I', runtime);
  execute format('grant select, insert on payments.payment to %I', runtime);
  execute format('revoke delete, truncate on payments.account, payments.link from %I', runtime);
  execute format('revoke update, delete, truncate on payments.payment from %I', runtime);
end $$;
