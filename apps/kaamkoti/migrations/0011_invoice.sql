-- Invoices (docs/architecture.md 5.3, 6, 8; step 4.4): the bill for a completed job, a copy of what was agreed
-- (the accepted quote plus the approved change orders). An invoice is a document: once written, nothing on it or
-- its lines changes. Only its status moves, issued → paid (when payments for the job cover it) or → void (by
-- the owner, who may then issue a new one). The triggers below enforce that here, not only in code.

-- The last invoice number each business used: taking the next one locks the row, so numbers have no gaps and
-- no repeats however many jobs complete at once. A voided invoice keeps its number.
create table kk.invoice_counter (
  business_id uuid primary key references tenancy.business (id),
  last_number integer not null check (last_number > 0)
);

create table kk.invoice (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  job_id uuid not null,
  number integer not null check (number > 0),
  status text not null default 'issued' check (status in ('issued', 'paid', 'void')),
  -- Sums of the lines, and how many there are; invoice_lines_match checks both at commit.
  net_minor bigint not null,
  tax_minor bigint not null,
  total_minor bigint not null check (total_minor >= 0),
  line_count integer not null check (line_count > 0),
  issued_at timestamptz not null default now(),
  paid_at timestamptz,
  voided_at timestamptz,
  check (total_minor = net_minor + tax_minor),
  -- A voided invoice keeps the time it was paid, if it was.
  check (status <> 'paid' or paid_at is not null),
  check (paid_at is null or status <> 'issued'),
  check ((status = 'void') = (voided_at is not null)),
  unique (business_id, number),
  -- Also the index for the job foreign key and for finding a job's invoices; target of invoice_line's key.
  unique (business_id, job_id, id),
  foreign key (business_id, job_id) references kk.job (business_id, id)
);
-- One invoice in force per job; a voided one makes room for the next.
create unique index invoice_one_live on kk.invoice (business_id, job_id) where status <> 'void';

-- A copy of the agreed lines, not a reference: the invoice must not change if a quote or change order did.
create table kk.invoice_line (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references tenancy.business (id),
  job_id uuid not null,
  invoice_id uuid not null,
  position integer not null check (position >= 0),
  -- The task the copied line priced; null for a charge on the whole job.
  job_task_id uuid,
  description text not null check (length(description) between 1 and 120),
  unit text not null check (unit in ('job', 'hour', 'unit', 'sq_ft', 'metre', 'visit')),
  quantity_milli bigint not null check (quantity_milli between 1 and 1000000000),
  unit_price_minor bigint not null check (unit_price_minor between -100000000 and 100000000),
  tax_rate_bp integer not null check (tax_rate_bp between 0 and 10000),
  net_minor bigint not null check (net_minor = round(quantity_milli::numeric * unit_price_minor / 1000)),
  tax_minor bigint not null check (tax_minor = round(net_minor::numeric * tax_rate_bp / 10000)),
  -- Also the index for the invoice foreign key and for reading its lines in order.
  unique (business_id, invoice_id, position),
  foreign key (business_id, job_id, invoice_id) references kk.invoice (business_id, job_id, id),
  foreign key (business_id, job_id, job_task_id) references kk.job_task (business_id, job_id, id)
);
create index invoice_line_job_task on kk.invoice_line (business_id, job_id, job_task_id);

-- Born issued. After that only the status moves, and nothing else on the row:
--   issued → paid    with paid_at, only when the job's recorded payments cover the total
--   issued | paid → void    with voided_at, by the owner
create function kk.invoice_guard() returns trigger
  language plpgsql set search_path = ''
as $$
declare
  received bigint;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'issued' or new.paid_at is not null or new.voided_at is not null then
      raise exception 'invoice %: it starts as issued', new.id using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.status = 'issued' and new.status = 'paid'
     and (to_jsonb(new) - array['status', 'paid_at']) is not distinct from
         (to_jsonb(old) - array['status', 'paid_at']) then
    select coalesce(sum(amount_minor), 0) into received
      from payments.payment where business_id = new.business_id and subject_id = new.job_id;
    if received < new.total_minor then
      raise exception 'invoice %: payments do not cover it', new.id using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.status in ('issued', 'paid') and new.status = 'void'
     and (to_jsonb(new) - array['status', 'voided_at']) is not distinct from
         (to_jsonb(old) - array['status', 'voided_at']) then
    return new;
  end if;
  raise exception 'invoice %: an invoice cannot change', old.id using errcode = 'check_violation';
end $$;
create trigger invoice_guard before insert or update on kk.invoice
  for each row execute function kk.invoice_guard();

-- At commit, an invoice has exactly line_count lines whose sums are its totals. The invoice and its lines are
-- written in one transaction; a line added later, in any transaction, breaks the count and is refused.
create function kk.invoice_lines_match() returns trigger
  language plpgsql set search_path = ''
as $$
declare
  target uuid;
  stored record;
  lines integer;
  lines_net bigint;
  lines_tax bigint;
begin
  -- Two tables share this function; each branch reads only its own table's columns.
  if tg_table_name = 'invoice' then
    target := new.id;
  else
    target := new.invoice_id;
  end if;
  select i.line_count, i.net_minor, i.tax_minor into stored from kk.invoice i where i.id = target;
  select count(*), coalesce(sum(l.net_minor), 0), coalesce(sum(l.tax_minor), 0)
    into lines, lines_net, lines_tax
    from kk.invoice_line l where l.invoice_id = target;
  if lines <> stored.line_count or lines_net <> stored.net_minor or lines_tax <> stored.tax_minor then
    raise exception 'invoice %: totals do not match its lines', target using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger invoice_lines_match after insert on kk.invoice
  deferrable initially deferred for each row execute function kk.invoice_lines_match();
create constraint trigger invoice_line_matches after insert on kk.invoice_line
  deferrable initially deferred for each row execute function kk.invoice_lines_match();

alter table kk.invoice_counter enable row level security;
create policy tenant on kk.invoice_counter
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
alter table kk.invoice enable row level security;
create policy tenant on kk.invoice
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
alter table kk.invoice_line enable row level security;
create policy tenant on kk.invoice_line
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- An invoice is never deleted, and its lines are only ever inserted.
do $$
declare
  runtime text := current_setting('db.runtime_role');
begin
  execute format('grant select, insert, update on kk.invoice_counter to %I', runtime);
  execute format('revoke delete, truncate on kk.invoice_counter from %I', runtime);
  execute format('grant select, insert, update on kk.invoice to %I', runtime);
  execute format('revoke delete, truncate on kk.invoice from %I', runtime);
  execute format('grant select, insert on kk.invoice_line to %I', runtime);
  execute format('revoke update, delete, truncate on kk.invoice_line from %I', runtime);
end $$;
