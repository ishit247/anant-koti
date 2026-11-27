-- The app's copy of each business's subscription (docs/architecture.md 13). Platform holds the subscription and
-- moves it only from the provider's verified webhook; this row follows its signed `billing.status_changed`
-- events, newest version only. Signup writes it with the trial, at the version platform's opening row has.
-- Whether the business is live is computed from it at request time, never stored. No foreign key to tenancy, as
-- in payments: the business id is the RLS key.
create schema billing;

create table billing.status (
  business_id uuid primary key,
  plan text not null check (plan in ('solo', 'team')),
  seats int not null check (seats between 1 and 100),
  status text not null check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  trial_ends_at timestamptz not null,
  -- The end of the last period paid for; null until the first payment.
  paid_through timestamptz,
  -- Platform's version of the subscription: an event applies only if its version is greater.
  version int not null check (version >= 1),
  updated_at timestamptz not null default now(),
  check (plan <> 'solo' or seats = 1)
);

alter table billing.status enable row level security;
create policy tenant on billing.status
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- A GRANT never withholds, so what the runtime role must not do is revoked explicitly. A business's copy is
-- never deleted: data stays on lapse.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema billing to %I', runtime);
  execute format('grant select, insert, update on billing.status to %I', runtime);
  execute format('revoke delete, truncate on billing.status from %I', runtime);
end $$;
