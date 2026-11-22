-- The job: a customer's request and everything after it (docs/architecture.md 5.3, 6). Its link to the
-- accepted quote, accepted_quote_id, is added by 0007_quote.sql, which creates the table it refers to.
create table kk.job (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  customer_id uuid not null,
  -- Per business, shown to the customer as "Request #12".
  number integer not null check (number > 0),
  source text not null check (source in ('public_form', 'whatsapp_link', 'qr', 'phone')),
  status text not null default 'requested' check (status in (
    'requested', 'quoted', 'accepted', 'scheduled', 'in_progress', 'completed', 'declined', 'lost', 'cancelled'
  )),
  -- Whom to meet and where: copied at send from what the customer chose or typed, so editing or deleting a
  -- saved address, or a later request elsewhere, never rewrites this job. The mobile is anyone's.
  contact_name text not null check (length(contact_name) between 1 and 120),
  contact_phone_e164 text not null check (contact_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  address text check (length(address) between 1 and 500),
  -- The spot the customer picked with their phone's location, if they did; the owner opens it in a map.
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  check ((latitude is null) = (longitude is null)),
  cancel_reason text check (length(cancel_reason) between 1 and 500),
  created_at timestamptz not null default now(),
  -- Also the index for the business_id foreign key.
  unique (business_id, number),
  -- Target of composite foreign keys from job_task and job_photo.
  unique (business_id, id),
  -- Composite, so a job cannot name another business's customer.
  foreign key (business_id, customer_id) references kk.customer (business_id, id)
);
create index job_customer on kk.job (business_id, customer_id);

alter table kk.job enable row level security;
create policy tenant on kk.job
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
-- No delete: a job ends in a state (section 6), never by vanishing.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update on kk.job to %I', runtime);
end $$;
