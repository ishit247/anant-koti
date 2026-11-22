-- Quotes and their lines (docs/architecture.md 5.3, 6, 8). A job has numbered versions; the owner edits one
-- draft at a time and sends it, which supersedes the version before. What a customer was sent never changes:
-- the triggers below enforce that here, not only in code.
create table kk.quote (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  job_id uuid not null,
  version integer not null check (version > 0),
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'rejected', 'countered', 'superseded')),
  -- Expiry is computed at request time from valid_until (section 6); no stored status goes stale.
  valid_until timestamptz,
  sent_at timestamptz,
  -- Sums of the lines' rounded amounts, in the business's currency (section 8); checked against the lines on
  -- send by quote_guard.
  net_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  total_minor bigint not null default 0 check (total_minor >= 0),
  deposit_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  check (total_minor = net_minor + tax_minor),
  check (deposit_minor between 0 and total_minor),
  check ((status = 'draft') = (sent_at is null)),
  check (sent_at is null or valid_until > sent_at),
  -- Also the index for the job foreign key and for listing a job's versions.
  unique (business_id, job_id, version),
  -- Target of the composite foreign key from quote_line.
  unique (business_id, job_id, id),
  foreign key (business_id, job_id) references kk.job (business_id, id)
);
-- One draft to edit, and at most one quote out with the customer, per job.
create unique index quote_one_draft on kk.quote (business_id, job_id) where status = 'draft';
create unique index quote_one_sent on kk.quote (business_id, job_id) where status = 'sent';

create table kk.quote_line (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  job_id uuid not null,
  quote_id uuid not null,
  position integer not null check (position >= 0),
  -- Null for a request-level charge (visit fee, discount, one lump price); otherwise it prices that task.
  job_task_id uuid,
  -- Where the line came from, if from the price list. Description, unit, price and tax are copied, so a later
  -- price change does not rewrite a quote.
  catalogue_item_id uuid,
  description text not null check (length(description) between 1 and 120),
  unit text not null check (unit in ('job', 'hour', 'unit', 'sq_ft', 'metre', 'visit')),
  quantity_milli bigint not null check (quantity_milli between 1 and 1000000000),
  -- Negative for a discount line.
  unit_price_minor bigint not null check (unit_price_minor between -100000000 and 100000000),
  tax_rate_bp integer not null check (tax_rate_bp between 0 and 10000),
  -- The same rule as lineTotals in @bodhchakra/money: round(numeric) rounds halves away from zero.
  net_minor bigint not null check (net_minor = round(quantity_milli::numeric * unit_price_minor / 1000)),
  tax_minor bigint not null check (tax_minor = round(net_minor::numeric * tax_rate_bp / 10000)),
  -- Also the index for the quote foreign key and for reading a quote's lines in order.
  unique (business_id, quote_id, position),
  -- Composite, so a line belongs to a quote of its job and prices only a task of that same job.
  foreign key (business_id, job_id, quote_id) references kk.quote (business_id, job_id, id),
  foreign key (business_id, job_id, job_task_id) references kk.job_task (business_id, job_id, id),
  foreign key (business_id, catalogue_item_id) references kk.catalogue_item (business_id, id)
);
create index quote_line_job_task on kk.quote_line (business_id, job_id, job_task_id);
create index quote_line_catalogue_item on kk.quote_line (business_id, catalogue_item_id);

-- A quote is born a draft. While it is one, anything may change; leaving draft requires lines whose sums are
-- the stored totals. After that only the status moves, never back to draft. Negotiation (2.5) widens the
-- columns that may change after sending, by name.
create function kk.quote_guard() returns trigger
  language plpgsql set search_path = ''
as $$
declare
  line_count integer;
  line_net bigint;
  line_tax bigint;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'quote %: a quote starts as a draft', new.id using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.status = 'draft' then
    if new.status <> 'draft' then
      select count(*), coalesce(sum(net_minor), 0), coalesce(sum(tax_minor), 0)
        into line_count, line_net, line_tax
        from kk.quote_line where quote_id = new.id;
      if line_count = 0 or line_net <> new.net_minor or line_tax <> new.tax_minor then
        raise exception 'quote %: totals do not match its lines', new.id using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;
  if new.status = 'draft' or (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'quote %: a sent quote cannot change', old.id using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger quote_guard before insert or update on kk.quote
  for each row execute function kk.quote_guard();

-- Lines change only while their quote is a draft. FOR SHARE makes a line write and the send that freezes its
-- quote wait for each other, so a line cannot slip in beside a send.
create function kk.quote_line_guard() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' and exists (
    select 1 from kk.quote where id = old.quote_id and status <> 'draft' for share
  ) then
    raise exception 'quote %: lines of a sent quote cannot change', old.quote_id
      using errcode = 'check_violation';
  end if;
  if tg_op <> 'DELETE' and exists (
    select 1 from kk.quote where id = new.quote_id and status <> 'draft' for share
  ) then
    raise exception 'quote %: lines of a sent quote cannot change', new.quote_id
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger quote_line_guard before insert or update or delete on kk.quote_line
  for each row execute function kk.quote_line_guard();

alter table kk.quote enable row level security;
create policy tenant on kk.quote
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
alter table kk.quote_line enable row level security;
create policy tenant on kk.quote_line
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- A quote is never deleted: an unwanted version is superseded. Draft lines are replaced on each save, so lines
-- may be deleted (the trigger refuses it once sent). A GRANT never withholds, so what the runtime must not do is
-- revoked, and a test proves it.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update on kk.quote to %I', runtime);
  execute format('revoke delete, truncate on kk.quote from %I', runtime);
  execute format('grant select, insert, update, delete on kk.quote_line to %I', runtime);
  execute format('revoke truncate on kk.quote_line from %I', runtime);
end $$;
