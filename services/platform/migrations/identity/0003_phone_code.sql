-- Sign-in codes sent to a mobile by WhatsApp (docs/architecture.md 3, step 3.3c). Ours, not better-auth's: its
-- phone plugin keeps codes in plain text, so the plugin only verifies through `checkPhoneCode` against this
-- table. One live code per number; a new one replaces it. The code is a keyed hash: six digits are a million
-- guesses, so a plain hash read from the table would give it away.
create table identity.phone_code (
  phone text primary key check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  code_hash text not null,
  -- Guesses at this code; the fifth is the last.
  attempts integer not null default 0,
  expires_at timestamptz not null
);

do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update, delete on identity.phone_code to %I', runtime);
end $$;
