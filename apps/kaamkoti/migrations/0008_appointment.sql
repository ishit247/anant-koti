-- A planned visit to a job (docs/architecture.md 5.3, 6): a `site_visit` before the quote is accepted, or the
-- `work` after it. The technician is any member of the business, the owner included. The work's time is agreed
-- (3.1b): the owner proposes it (`proposed`), and the customer confirms it (`planned`) or asks for another
-- (`declined`, with their note).
create extension if not exists btree_gist;

create table kk.appointment (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  job_id uuid not null,
  kind text not null check (kind in ('site_visit', 'work')),
  technician_member_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'planned'
    check (status in ('proposed', 'planned', 'declined', 'done', 'cancelled')),
  customer_note text check (length(customer_note) between 1 and 500),
  answered_at timestamptz,
  on_the_way_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (status <> 'proposed' or kind = 'work'),
  -- No double booking: one technician cannot hold two visits that overlap. A proposed time holds the slot too,
  -- so the customer's confirmation can never collide. The range is half-open, so a visit may start the minute
  -- the previous one ends. Members have unique ids across businesses, so no business_id is needed here.
  exclude using gist (
    technician_member_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('proposed', 'planned')),
  -- Target of job_visit's composite foreign key.
  unique (business_id, id),
  foreign key (business_id, job_id) references kk.job (business_id, id),
  foreign key (business_id, technician_member_id) references tenancy.member (business_id, id)
);
-- A job's visits, and a technician's day: the exclusion constraint's index serves the second (technician first),
-- this one the first and the schedule list (business, then time).
create index appointment_job on kk.appointment (business_id, job_id);
create index appointment_schedule on kk.appointment (business_id, starts_at)
  where status in ('proposed', 'planned');

alter table kk.appointment enable row level security;
create policy tenant on kk.appointment
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
-- No delete: a visit leaves the plan by becoming `cancelled`.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update on kk.appointment to %I', runtime);
end $$;
