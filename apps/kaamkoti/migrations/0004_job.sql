-- The job: a customer's request and everything after it (docs/architecture.md 5.3, 6). The intake columns
-- (answers, address, preferred window) arrive with the request form in 2.2, quote links with 2.4.
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
  cancel_reason text check (length(cancel_reason) between 1 and 500),
  created_at timestamptz not null default now(),
  -- Also the index for the business_id foreign key.
  unique (business_id, number),
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
