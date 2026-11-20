-- Global trade templates (docs/architecture.md 5.3): no business_id, so no row-level security. The runtime role may
-- only read them; seeds write them as the owner role through saveTradeTemplate, which validates the JSON.
create table kk.trade_template (
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  version integer not null check (version >= 1),
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  created_at timestamptz not null default now(),
  primary key (key, version)
);

do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  -- Default privileges may already grant more; REVOKE is what restricts.
  execute format('revoke all on kk.trade_template from %I', runtime);
  execute format('grant select on kk.trade_template to %I', runtime);
end $$;
