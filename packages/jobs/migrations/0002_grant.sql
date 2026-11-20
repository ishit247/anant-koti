-- The runtime role works the queues but owns nothing (docs/architecture.md 2): row rights on pg-boss's tables,
-- and no TRUNCATE. Queues are not partitioned (createJobs never asks for it), so creating one is an INSERT and
-- needs no DDL. A pg-boss upgrade adds its migration plan as a new file followed by these grants again.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema pgboss to %I', runtime);
  execute format('grant select, insert, update, delete on all tables in schema pgboss to %I', runtime);
  execute format('grant usage, select on all sequences in schema pgboss to %I', runtime);
  execute format('revoke truncate on all tables in schema pgboss from %I', runtime);
end $$;
