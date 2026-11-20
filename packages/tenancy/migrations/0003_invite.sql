-- A technician is invited by a link the owner shares (docs/architecture.md 4.1, 7). The link itself is a
-- tokens.token; this row says what it grants and whether it was used.
create table tenancy.invite (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  -- Only technicians are invited: a business has one owner (member_one_owner).
  role text not null check (role = 'technician'),
  invited_by uuid not null references tenancy.member (id),
  token_id uuid not null references tokens.token (id),
  accepted_member_id uuid references tenancy.member (id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index invite_business on tenancy.invite (business_id);
create index invite_invited_by on tenancy.invite (invited_by);
create unique index invite_token on tenancy.invite (token_id);
create index invite_accepted_member on tenancy.invite (accepted_member_id) where accepted_member_id is not null;

alter table tenancy.invite enable row level security;
create policy tenant on tenancy.invite
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- The invitee has no membership yet, so RLS shows them nothing; the page that asks "join Sharma Cooling?"
-- reads the business name and the inviter through this function, after the link has resolved.
create function tenancy.invite_summary(p_invite_id uuid)
  returns table (business_name text, invited_by_name text)
  language sql stable security definer set search_path = ''
  as $$
    select b.name, m.display_name
    from tenancy.invite i
    join tenancy.business b on b.id = i.business_id
    join tenancy.member m on m.id = i.invited_by
    where i.id = p_invite_id
  $$;
revoke execute on function tenancy.invite_summary(uuid) from public;

do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update on tenancy.invite to %I', runtime);
  execute format('grant execute on function tenancy.invite_summary(uuid) to %I', runtime);
  -- Only acceptance changes an invite.
  execute format('revoke update on tenancy.invite from %I', runtime);
  execute format('grant update (accepted_member_id) on tenancy.invite to %I', runtime);
end $$;
