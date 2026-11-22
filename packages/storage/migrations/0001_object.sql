-- Stored files (docs/architecture.md 10): one row per object in a private bucket. The key is random and never
-- the file name; the bytes in the bucket are the re-encoded image, and sha256 is theirs.
create schema storage;

create table storage.object (
  id uuid primary key default gen_random_uuid(),
  -- No foreign keys to tenancy: this module sits below it.
  business_id uuid not null,
  bucket text not null check (bucket ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  key text not null check (key ~ '^[0-9a-f-]{36}\.(jpeg|png|webp)$'),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  bytes integer not null check (bytes > 0),
  sha256 bytea not null check (length(sha256) = 32),
  -- The member who uploaded it; null when a customer did, through the public form or their link.
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (bucket, key),
  -- Also the business_id index, and the target of composite foreign keys, so an app row can only name an
  -- object of its own business: foreign key checks do not see RLS.
  unique (business_id, id)
);

alter table storage.object enable row level security;
create policy tenant on storage.object
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- Objects never change after upload; removing one is its own step, with the bucket delete beside it.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant usage on schema storage to %I', runtime);
  execute format('grant select, insert on storage.object to %I', runtime);
end $$;
