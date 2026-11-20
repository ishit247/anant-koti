-- The tenant (docs/architecture.md 4.1, 4.2). The runtime role sees and changes only the business named by
-- app.business_id (set by db.withTenant), so a new business is created inside withTenant of its own new id.
create schema tenancy;

create table tenancy.business (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 60),
  name text not null check (length(name) between 1 and 120),
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  city text not null check (length(city) between 1 and 80),
  timezone text not null default 'Asia/Kolkata',
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);

alter table tenancy.business enable row level security;
create policy tenant on tenancy.business
  using (id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.business_id', true), '')::uuid);

-- Public pages arrive with a slug and no tenant. This returns only the id, which then opens withTenant.
-- Security definer runs as the owner, which RLS does not restrict; search_path is empty so nothing can shadow
-- the qualified names.
create function tenancy.resolve_slug(p_slug text) returns uuid
  language sql stable security definer set search_path = ''
  as $$ select id from tenancy.business where slug = p_slug $$;
-- Functions are executable by PUBLIC by default; only the runtime role may call this one.
revoke execute on function tenancy.resolve_slug(text) from public;

-- No delete: closing a business is its own step.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema tenancy to %I', runtime);
  execute format('grant select, insert, update on tenancy.business to %I', runtime);
  execute format('grant execute on function tenancy.resolve_slug(text) to %I', runtime);
end $$;
