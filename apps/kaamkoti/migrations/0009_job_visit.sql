-- The work done on site (docs/architecture.md 5.3, 6; step 4.2): created when the technician checks in on the
-- job's planned work visit, which moves the job to `in_progress`, and closed when they mark it complete. One per
-- job: the basic job is done in one visit. Who checked in and who completed is in the audit.
create table kk.job_visit (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  job_id uuid not null,
  appointment_id uuid not null,
  checked_in_at timestamptz not null default now(),
  -- The business's checklist as it stood at check-in, each item with its tick: [{key, label, done}]. Copied, so
  -- a later edit of the business's checklist does not rewrite a visit. Parsed with Zod on write and read.
  checklist jsonb not null check (jsonb_typeof(checklist) = 'array'),
  completed_at timestamptz,
  -- What the technician leaves for the owner when completing ("replaced the capacitor").
  note text check (length(note) between 1 and 1000),
  check (completed_at is null or completed_at >= checked_in_at),
  -- Also the indexes for both foreign keys.
  unique (business_id, job_id),
  unique (business_id, appointment_id),
  foreign key (business_id, job_id) references kk.job (business_id, id),
  foreign key (business_id, appointment_id) references kk.appointment (business_id, id)
);

alter table kk.job_visit enable row level security;
create policy tenant on kk.job_visit
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
-- No delete: a visit, like the job it records, stays.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update on kk.job_visit to %I', runtime);
end $$;
