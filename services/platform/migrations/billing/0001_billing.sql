-- Billing (docs/architecture.md 13): what a business pays the platform, by subscription (D6, D9). The account
-- belongs to an identity, the payer, so one person has one bill across products (D12); it holds one subscription
-- per product tenant. Status moves only from the provider's verified webhook; registering a business opens its
-- trial. Reached only through billing's own code (services/platform/src/billing.ts), with no tenant context, so
-- like notify.message there is no RLS.
create schema billing;

create table billing.account (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null unique references identity."user" (id),
  created_at timestamptz not null default now()
);

create table billing.subscription (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references billing.account (id),
  -- The app's signed client id, and the business in it.
  product text not null check (length(product) between 1 and 40),
  tenant_id uuid not null,
  plan text not null check (plan in ('solo', 'team')),
  seats int not null check (seats between 1 and 100),
  status text not null check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  trial_ends_at timestamptz not null,
  -- The end of the last period paid for; it only moves forward.
  paid_through timestamptz,
  -- The provider's subscription now in force or waiting to be authorised. A newer checkout replaces it, and
  -- webhooks about any other one are ignored.
  provider_subscription_id text unique check (provider_subscription_id ~ '^sub_[A-Za-z0-9]{6,40}$'),
  -- The page where the owner authorises it; cleared once they have.
  checkout_url text check (checkout_url ~ '^https?://'),
  -- When the last provider event applied was made at the provider: an older one, arriving late, changes nothing.
  provider_event_at timestamptz,
  -- Grows by one with every change; the app keeps the newest it has seen.
  version int not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product, tenant_id),
  check (plan <> 'solo' or seats = 1),
  check (checkout_url is null or provider_subscription_id is not null)
);
create index subscription_account on billing.subscription (account_id);

-- A GRANT never withholds, so the rights the runtime role must not have are revoked explicitly.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema billing to %I', runtime);
  execute format('grant select, insert on billing.account to %I', runtime);
  execute format('revoke update, delete, truncate on billing.account from %I', runtime);
  execute format('grant select, insert, update on billing.subscription to %I', runtime);
  execute format('revoke delete, truncate on billing.subscription from %I', runtime);
end $$;
