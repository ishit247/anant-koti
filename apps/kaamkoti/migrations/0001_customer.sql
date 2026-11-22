-- The app's schema, and the customer: found or created by phone when a request arrives (docs/architecture.md 5.3).
create schema kk;

create table kk.customer (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  -- The platform identity that signs in as this customer (D15). Null for a customer the owner entered, until
  -- someone signs in with the email (or, from 3.3, the phone) on the row and claims it.
  identity_id uuid,
  name text not null check (length(name) between 1 and 120),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email text check (email ~ '^[^@\s]+@[^@\s]+$'),
  address text check (length(address) <= 500),
  created_at timestamptz not null default now(),
  -- Also the index for the business_id foreign key and for listing a business's customers.
  unique (business_id, phone_e164),
  -- Target of composite foreign keys, so a row can only name a customer of its own business: foreign key
  -- checks do not see RLS.
  unique (business_id, id),
  -- One customer row per person per business; also the index the customer space resolves a session by.
  unique (business_id, identity_id)
);
-- The claim looks for an unclaimed row by email, case ignored.
create index customer_unclaimed_email on kk.customer (business_id, lower(email)) where identity_id is null;

alter table kk.customer enable row level security;
create policy tenant on kk.customer
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
-- The runtime role comes from the migration runner (db.runtime_role), as in every module migration.
-- No delete: erasing a customer is its own step with an audit trail.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema kk to %I', runtime);
  execute format('grant select, insert, update on kk.customer to %I', runtime);
end $$;
