-- Fixture: the pattern every module migration uses to grant to a runtime role it cannot name.
create schema fx;
create table fx.flag (id int);
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema fx to %I', runtime);
  execute format('grant select on fx.flag to %I', runtime);
end $$;
