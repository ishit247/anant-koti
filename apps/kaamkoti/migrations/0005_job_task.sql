-- One piece of work in a request (docs/architecture.md 5.3). The customer picks one or more catalogue items on
-- the public form; the business can add custom tasks later. Quote lines (2.4) price them.
create table kk.job_task (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  job_id uuid not null,
  -- Null for a custom task. The title is copied, so renaming a catalogue item does not rewrite a request.
  catalogue_item_id uuid,
  title text not null check (length(title) between 1 and 120),
  status text not null default 'requested'
    check (status in ('requested', 'quoted', 'approved', 'done', 'dropped')),
  added_by text not null check (added_by in ('customer', 'business')),
  -- clock_timestamp, not now(): the tasks of one request are added in one transaction, and are listed in the
  -- order they were added.
  added_at timestamptz not null default clock_timestamp(),
  -- Composite, so a task belongs to a job and names a catalogue item of its own business only.
  foreign key (business_id, job_id) references kk.job (business_id, id),
  foreign key (business_id, catalogue_item_id) references kk.catalogue_item (business_id, id)
);
-- A job's tasks are always read together; this also indexes the job foreign key.
create index job_task_job on kk.job_task (business_id, job_id);
create index job_task_catalogue_item on kk.job_task (business_id, catalogue_item_id);

alter table kk.job_task enable row level security;
create policy tenant on kk.job_task
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
-- No delete: a task leaves a request by becoming `dropped`.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update on kk.job_task to %I', runtime);
end $$;
