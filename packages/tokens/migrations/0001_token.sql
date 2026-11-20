-- Scoped, expiring, revocable links (docs/architecture.md 7): invites now, customer job links in 2.1.
-- The link holds 32 random bytes; only their SHA-256 is stored, so a read of this table opens no link.
create schema tokens;

create table tokens.token (
  id uuid primary key default gen_random_uuid(),
  hash bytea not null unique check (length(hash) = 32),
  purpose text not null check (purpose in ('job', 'invite')),
  -- No foreign key: this module is below tenancy, which references it.
  business_id uuid not null,
  -- What the link opens: the invite or the job.
  subject_id uuid not null,
  actions text[] not null default '{}',
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index token_business on tokens.token (business_id);

alter table tokens.token enable row level security;
create policy tenant on tokens.token
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- A person arrives with the link and no tenant, so RLS would show them nothing. This returns the one live
-- token for a hash (not revoked, not expired); the caller then opens withTenant of its business.
create function tokens.resolve(p_hash bytea)
  returns table (id uuid, purpose text, business_id uuid, subject_id uuid, actions text[])
  language sql stable security definer set search_path = ''
  as $$
    select id, purpose, business_id, subject_id, actions
    from tokens.token
    where hash = p_hash and revoked_at is null and expires_at > now()
  $$;
revoke execute on function tokens.resolve(bytea) from public;

-- No delete: a revoked link stays as the record that it existed.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema tokens to %I', runtime);
  execute format('grant select, insert, update on tokens.token to %I', runtime);
  execute format('grant execute on function tokens.resolve(bytea) to %I', runtime);
  -- A GRANT never withholds: only revoked_at and expires_at ever change, so nothing else may.
  execute format('revoke update on tokens.token from %I', runtime);
  execute format('grant update (revoked_at, expires_at) on tokens.token to %I', runtime);
end $$;
