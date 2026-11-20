-- The runtime role works identity's rows but owns nothing (docs/architecture.md 2): row rights on better-auth's
-- tables and no TRUNCATE. A better-auth upgrade that changes the schema regenerates 0001 until the first real
-- tenant; after that it adds the difference as a new file, followed by these grants again.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema identity to %I', runtime);
  execute format('grant select, insert, update, delete on all tables in schema identity to %I', runtime);
  execute format('revoke truncate on all tables in schema identity from %I', runtime);
end $$;
