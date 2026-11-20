-- The tenant (docs/architecture.md 4.1). Members, invites, the runtime role's rights on this schema and
-- tenancy.resolve_slug arrive with the rest of the module in step 0.4.
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
