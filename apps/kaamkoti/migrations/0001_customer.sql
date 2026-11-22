-- The app's schema, the customer (the account holder: who asks and signs in) and their address book
-- (docs/architecture.md 5.3). Where the work is and whom to meet there belong to each job and its saved address,
-- not to the customer: a request can be for a parent's house or a shop.
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

-- A place the customer has asked for work at, with the person to meet there. At most 10 per customer (the app
-- counts under a lock on the customer row). A job copies what it needs at send, so editing or deleting an
-- address never changes a job.
create table kk.customer_address (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  customer_id uuid not null,
  -- The customer's own name for it: Home, Parents, Shop.
  label text not null check (length(label) between 1 and 40),
  contact_name text not null check (length(contact_name) between 1 and 120),
  -- Anyone's mobile, not only the customer's, so not unique.
  contact_phone_e164 text not null check (contact_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  address text not null check (length(address) between 1 and 500),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  check ((latitude is null) = (longitude is null)),
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- Composite, so an address cannot name another business's customer.
  foreign key (business_id, customer_id) references kk.customer (business_id, id)
);
-- The customer's book, most recently used first; also the index for the foreign key.
create index customer_address_book on kk.customer_address (business_id, customer_id, last_used_at desc);

alter table kk.customer_address enable row level security;
create policy tenant on kk.customer_address
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
-- Delete is allowed: nothing refers to an address, and the customer may remove one.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update, delete on kk.customer_address to %I', runtime);
end $$;
