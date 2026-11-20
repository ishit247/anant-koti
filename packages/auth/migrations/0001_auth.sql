-- The app side of sign-in (docs/architecture.md 3). Neither table has RLS: they belong to the process, and turn
-- a callback or a cookie into an identity, which then finds its memberships through tenancy.memberships_of.
create schema auth;

-- One per started sign-in, consumed by the callback that finishes it: deleted in the same statement that reads
-- it, so a replayed callback finds nothing. Expired rows are purged whenever a sign-in starts.
create table auth.login_attempt (
  state text primary key check (length(state) between 32 and 64),
  nonce text not null,
  code_verifier text not null,
  return_to text not null check (return_to like '/%'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index login_attempt_expires on auth.login_attempt (expires_at);

-- The browser holds the token; only its SHA-256 is stored, so a read of this table opens no session.
-- id_token is kept only as the hint platform's end-session needs to sign the person out there too; it goes
-- with the row, on sign-out or expiry. Expired rows are purged whenever someone signs in.
create table auth.session (
  token_hash bytea primary key check (length(token_hash) = 32),
  identity_id uuid not null,
  id_token text not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index session_expires on auth.session (expires_at);
create index session_last_seen on auth.session (last_seen_at);

do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema auth to %I', runtime);
  execute format('grant select, insert, delete on auth.login_attempt to %I', runtime);
  execute format('grant select, insert, update, delete on auth.session to %I', runtime);
  -- A GRANT never withholds: an attempt is never changed, and neither table is emptied wholesale.
  execute format('revoke update, truncate on auth.login_attempt from %I', runtime);
  execute format('revoke truncate on auth.session from %I', runtime);
end $$;
