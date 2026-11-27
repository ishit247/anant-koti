-- Change orders (docs/architecture.md 5.3, 6; step 4.3): work added after the customer accepted the quote, priced
-- by the business and approved or rejected by the customer. The accepted quote never changes; a change order adds
-- to it. Like a quote it is born a draft, and what the customer was shown never changes: the triggers below
-- enforce that here, not only in code. The invoice (4.4) takes the accepted quote and the approved ones only.
create table kk.change_order (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  job_id uuid not null,
  -- 1, 2, … per job, as the customer sees them ("Extra work 2").
  number integer not null check (number > 0),
  status text not null default 'draft' check (status in ('draft', 'proposed', 'approved', 'rejected')),
  proposed_at timestamptz,
  decided_at timestamptz,
  -- Sums of the lines' rounded amounts, checked against the lines on proposal by change_order_guard.
  net_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  total_minor bigint not null default 0 check (total_minor >= 0),
  created_at timestamptz not null default now(),
  check (total_minor = net_minor + tax_minor),
  check ((status = 'draft') = (proposed_at is null)),
  check ((status in ('approved', 'rejected')) = (decided_at is not null)),
  -- Also the index for the job foreign key and for listing a job's change orders.
  unique (business_id, job_id, number),
  -- Target of the composite foreign key from change_order_line.
  unique (business_id, job_id, id),
  foreign key (business_id, job_id) references kk.job (business_id, id)
);
-- One draft to edit, and at most one change order waiting for the customer, per job.
create unique index change_order_one_draft on kk.change_order (business_id, job_id) where status = 'draft';
create unique index change_order_one_proposed on kk.change_order (business_id, job_id)
  where status = 'proposed';

-- The same shape and arithmetic as kk.quote_line.
create table kk.change_order_line (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  job_id uuid not null,
  change_order_id uuid not null,
  position integer not null check (position >= 0),
  -- Null for a charge on the whole job (materials, a call-out); otherwise it prices that task.
  job_task_id uuid,
  catalogue_item_id uuid,
  description text not null check (length(description) between 1 and 120),
  unit text not null check (unit in ('job', 'hour', 'unit', 'sq_ft', 'metre', 'visit')),
  quantity_milli bigint not null check (quantity_milli between 1 and 1000000000),
  unit_price_minor bigint not null check (unit_price_minor between -100000000 and 100000000),
  tax_rate_bp integer not null check (tax_rate_bp between 0 and 10000),
  net_minor bigint not null check (net_minor = round(quantity_milli::numeric * unit_price_minor / 1000)),
  tax_minor bigint not null check (tax_minor = round(net_minor::numeric * tax_rate_bp / 10000)),
  -- Also the index for the change order foreign key and for reading its lines in order.
  unique (business_id, change_order_id, position),
  -- Composite, so a line belongs to a change order of its job and prices only a task of that same job.
  foreign key (business_id, job_id, change_order_id) references kk.change_order (business_id, job_id, id),
  foreign key (business_id, job_id, job_task_id) references kk.job_task (business_id, job_id, id),
  foreign key (business_id, catalogue_item_id) references kk.catalogue_item (business_id, id)
);
create index change_order_line_job_task on kk.change_order_line (business_id, job_id, job_task_id);
create index change_order_line_catalogue_item on kk.change_order_line (business_id, catalogue_item_id);

-- A change order is born a draft; while it is one, anything may change. Proposing it needs lines whose sums are
-- the stored totals. After that only the customer's answer moves it, once:
--   proposed → approved | rejected   status and decided_at only
-- An approved or rejected change order never changes again.
create function kk.change_order_guard() returns trigger
  language plpgsql set search_path = ''
as $$
declare
  line_count integer;
  line_net bigint;
  line_tax bigint;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'change order %: it starts as a draft', new.id using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.status = 'draft' then
    if new.status = 'proposed' then
      select count(*), coalesce(sum(net_minor), 0), coalesce(sum(tax_minor), 0)
        into line_count, line_net, line_tax
        from kk.change_order_line where change_order_id = new.id;
      if line_count = 0 or line_net <> new.net_minor or line_tax <> new.tax_minor then
        raise exception 'change order %: totals do not match its lines', new.id
          using errcode = 'check_violation';
      end if;
    elsif new.status <> 'draft' then
      raise exception 'change order %: a draft is proposed before it is answered', new.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.status = 'proposed' and new.status in ('approved', 'rejected')
     and (to_jsonb(new) - array['status', 'decided_at']) is not distinct from
         (to_jsonb(old) - array['status', 'decided_at']) then
    return new;
  end if;
  raise exception 'change order %: a proposed change order cannot change', old.id
    using errcode = 'check_violation';
end $$;
create trigger change_order_guard before insert or update on kk.change_order
  for each row execute function kk.change_order_guard();

-- Lines change only while their change order is a draft. FOR SHARE makes a line write and the proposal that
-- freezes it wait for each other, as for quote lines.
create function kk.change_order_line_guard() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' and exists (
    select 1 from kk.change_order where id = old.change_order_id and status <> 'draft' for share
  ) then
    raise exception 'change order %: lines of a proposed change order cannot change', old.change_order_id
      using errcode = 'check_violation';
  end if;
  if tg_op <> 'DELETE' and exists (
    select 1 from kk.change_order where id = new.change_order_id and status <> 'draft' for share
  ) then
    raise exception 'change order %: lines of a proposed change order cannot change', new.change_order_id
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger change_order_line_guard before insert or update or delete on kk.change_order_line
  for each row execute function kk.change_order_line_guard();

alter table kk.change_order enable row level security;
create policy tenant on kk.change_order
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
alter table kk.change_order_line enable row level security;
create policy tenant on kk.change_order_line
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- A change order is never deleted; draft lines are replaced on each save (the trigger refuses it once proposed).
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update on kk.change_order to %I', runtime);
  execute format('revoke delete, truncate on kk.change_order from %I', runtime);
  execute format('grant select, insert, update, delete on kk.change_order_line to %I', runtime);
  execute format('revoke truncate on kk.change_order_line from %I', runtime);
end $$;
