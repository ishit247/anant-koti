-- A person's role in one business (docs/architecture.md 4.1). identity_id is the platform identity (the OIDC
-- `sub`); the name, email and phone stay in platform. Invites arrive with tokens, in step 0.7.
create table tenancy.member (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  identity_id uuid not null,
  display_name text not null check (length(display_name) between 1 and 120),
  role text not null check (role in ('owner', 'technician')),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  -- Also the index for the business_id foreign key and for listing a business's members.
  unique (business_id, identity_id)
);

-- One owner per business in the MVP (4.1).
create unique index member_one_owner on tenancy.member (business_id)
  where role = 'owner' and removed_at is null;
create index member_identity on tenancy.member (identity_id) where removed_at is null;

alter table tenancy.member enable row level security;
create policy tenant on tenancy.member
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- Sign-in knows the identity but not yet the business, so RLS would show it nothing. This returns the
-- identity's current memberships only; the request then runs inside withTenant of the one it uses.
create function tenancy.memberships_of(p_identity_id uuid)
  returns table (member_id uuid, business_id uuid, role text, display_name text)
  language sql stable security definer set search_path = ''
  as $$
    select id, business_id, role, display_name
    from tenancy.member
    where identity_id = p_identity_id and removed_at is null
    order by created_at
  $$;
revoke execute on function tenancy.memberships_of(uuid) from public;

-- No delete: a member leaves by removed_at, so their past work keeps its author.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update on tenancy.member to %I', runtime);
  execute format('grant execute on function tenancy.memberships_of(uuid) to %I', runtime);
end $$;
