-- A job's photos (docs/architecture.md 5.3, 10): the customer's with the request, the technician's before and
-- after the work. The bytes are in the private bucket; storage.object records them.
create table kk.job_photo (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  job_id uuid not null,
  object_id uuid not null unique,
  kind text not null check (kind in ('request', 'before', 'after')),
  -- The work item the photo shows. A customer's photo always belongs to one.
  job_task_id uuid,
  -- clock_timestamp, as for job_task: photos sent together are shown in the order they were sent.
  created_at timestamptz not null default clock_timestamp(),
  check (kind <> 'request' or job_task_id is not null),
  -- Composite, so a photo row can name only a job, a task of that job and an object of its own business.
  foreign key (business_id, job_id) references kk.job (business_id, id),
  foreign key (business_id, job_id, job_task_id) references kk.job_task (business_id, job_id, id),
  foreign key (business_id, object_id) references storage.object (business_id, id)
);
create index job_photo_job on kk.job_photo (business_id, job_id, created_at);

alter table kk.job_photo enable row level security;
create policy tenant on kk.job_photo
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
-- Insert and read only: a photo, like its object, does not change.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert on kk.job_photo to %I', runtime);
end $$;
