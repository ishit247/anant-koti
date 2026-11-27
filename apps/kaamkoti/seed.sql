-- Development seed, run by `pnpm run up:fresh` as kaamkoti_owner in one transaction. Fixed ids so tests and
-- manual checks can name rows. Two businesses with three customers each, so isolation always has rows on both
-- sides. Phone numbers are in the fictional +91 90000 range; emails use example.com.
-- Grows with the schema: two requests per business, one of Sharma's quoted, and Kaveri's #3 negotiated to
-- acceptance, Sharma's #3 scheduled for today's work; jobs across the other states of section 6 arrive with the
-- steps that move them there.
insert into tenancy.business (id, slug, name, phone, city) values
  ('10000000-0000-4000-8000-000000000001', 'sharma-cooling', 'Sharma Cooling Services', '+919000000101', 'Pune'),
  ('20000000-0000-4000-8000-000000000002', 'kaveri-electricals', 'Kaveri Electricals', '+919000000202', 'Bengaluru');

-- identity_id values are the platform identities in services/platform/seed.sql (same ids, example.com emails).
insert into tenancy.member (id, business_id, identity_id, display_name, role) values
  ('10000000-0000-4000-8000-0000000a0001', '10000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-00000000d001', 'Prakash Sharma', 'owner'),
  ('10000000-0000-4000-8000-0000000a0002', '10000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-00000000d002', 'Imran Shaikh', 'technician'),
  ('20000000-0000-4000-8000-0000000a0001', '20000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-00000000d003', 'Kavya Reddy', 'owner'),
  ('20000000-0000-4000-8000-0000000a0002', '20000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-00000000d004', 'Manjunath B', 'technician');

-- Each business has a signed-in customer (identity_id set: Anita at Sharma, Suresh at Kaveri; their identities
-- are in services/platform/seed.sql) and owner-entered ones (no identity_id). Meera and Kaveri's Anita carry an
-- email, so signing in with it claims the row (meera@example.com has no identity yet; platform creates one).
insert into kk.customer (id, business_id, identity_id, name, phone_e164, email) values
  ('10000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-00000000d005', 'Anita Deshpande', '+919000001001', 'anita@example.com'),
  ('10000000-0000-4000-8000-0000000c0002', '10000000-0000-4000-8000-000000000001', null,
   'Rahul Joshi', '+919000001002', null),
  ('10000000-0000-4000-8000-0000000c0003', '10000000-0000-4000-8000-000000000001', null,
   'Meera Kulkarni', '+919000001003', 'meera@example.com'),
  ('20000000-0000-4000-8000-0000000c0001', '20000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-00000000d006', 'Suresh Gowda', '+919000002001', 'suresh@example.com'),
  ('20000000-0000-4000-8000-0000000c0002', '20000000-0000-4000-8000-000000000002', null,
   'Lakshmi Rao', '+919000002002', null),
  -- Same phone as a Sharma customer: one person can be a customer of two businesses. Entered by Kaveri's
  -- owner; Anita claims it by signing in at Kaveri's space with the same email.
  ('20000000-0000-4000-8000-0000000c0003', '20000000-0000-4000-8000-000000000002', null,
   'Anita Deshpande', '+919000001001', 'Anita@Example.com');

-- Address books. Anita at Sharma has her own flat and her parents' house, where her father is the one to meet;
-- Home was used last, so the request form preselects it. Rahul and Suresh have one each.
insert into kk.customer_address (id, business_id, customer_id, label, contact_name, contact_phone_e164, address,
                                 latitude, longitude, last_used_at) values
  ('10000000-0000-4000-8000-000000110001', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000c0001', 'Home', 'Anita Deshpande', '+919000001001',
   'Flat 4, Shanti Apartments, Kothrud, Pune', 18.507400, 73.807700, now() - interval '1 day'),
  ('10000000-0000-4000-8000-000000110002', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000c0001', 'Parents', 'Vasant Deshpande', '+919000001011',
   '22 Prabhat Road, Erandwane, Pune', null, null, now() - interval '20 days'),
  ('10000000-0000-4000-8000-000000110003', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000c0002', 'Home', 'Rahul Joshi', '+919000001002',
   '12 Lane 5, Baner, Pune', null, null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000110001', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000c0001', 'Home', 'Suresh Gowda', '+919000002001',
   '88 4th Cross, Jayanagar, Bengaluru', null, null, now() - interval '2 days');

-- Both businesses are onboarded. Sharma started from the ac_repair template (as startFromTemplate would copy it);
-- Kaveri built its own list. Prices are in paise, tax in basis points.
insert into kk.business_profile (business_id, trade_key, about, service_area, checklist, terms) values
  ('10000000-0000-4000-8000-000000000001', 'ac_repair', 'AC and appliance repair across Pune since 2012.',
   'Pune, Pimpri-Chinchwad',
   '[{"key":"power_off","label":"Power isolated before opening"},{"key":"cause_found","label":"Cause of the fault found and explained to the customer"},{"key":"drain_checked","label":"Drain line clear, no leaks"}]',
   'Quote is valid for 7 days. Parts replaced carry a 30-day warranty. Payment is due on completion.'),
  ('20000000-0000-4000-8000-000000000002', 'electrician', '', 'Bengaluru south', '[]',
   'Payment is due on completion.');

insert into kk.catalogue_item (id, business_id, name, unit, unit_price_minor, tax_rate_bp, position) values
  ('10000000-0000-4000-8000-0000000b0001', '10000000-0000-4000-8000-000000000001', 'Inspection visit', 'visit', 30000, 1800, 0),
  ('10000000-0000-4000-8000-0000000b0002', '10000000-0000-4000-8000-000000000001', 'AC gas refill', 'unit', 250000, 1800, 1),
  ('10000000-0000-4000-8000-0000000b0003', '10000000-0000-4000-8000-000000000001', 'AC general service', 'unit', 80000, 1800, 2),
  ('20000000-0000-4000-8000-0000000b0001', '20000000-0000-4000-8000-000000000002', 'Fan installation', 'unit', 40000, 1800, 0),
  ('20000000-0000-4000-8000-0000000b0002', '20000000-0000-4000-8000-000000000002', 'House rewiring', 'sq_ft', 9000, 1800, 1);

-- A request names one or more work items (tasks): a price-list item, or the customer's own words for the
-- business to price. Photos are not seeded: their bytes live in Garage, not in this file.
-- Each job carries its own contact and address, copied at send.
insert into kk.job (id, business_id, customer_id, number, source, contact_name, contact_phone_e164, address,
                    latitude, longitude) values
  ('10000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000c0001', 1, 'public_form', 'Anita Deshpande', '+919000001001',
   'Flat 4, Shanti Apartments, Kothrud, Pune', 18.507400, 73.807700),
  ('10000000-0000-4000-8000-0000000e0002', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000c0002', 2, 'phone', 'Rahul Joshi', '+919000001002',
   '12 Lane 5, Baner, Pune', null, null),
  ('20000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000c0001', 1, 'public_form', 'Suresh Gowda', '+919000002001',
   '88 4th Cross, Jayanagar, Bengaluru', null, null),
  ('20000000-0000-4000-8000-0000000e0002', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000c0003', 2, 'phone', 'Anita Deshpande', '+919000001001',
   '21 Residency Road, Bengaluru', null, null);

insert into kk.job_task (id, business_id, job_id, catalogue_item_id, title, details, added_by) values
  ('10000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000b0002', 'AC gas refill',
   'Split AC in the bedroom, not cooling since last week.', 'customer'),
  ('10000000-0000-4000-8000-0000000f0002', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000b0003', 'AC general service',
   null, 'customer'),
  ('10000000-0000-4000-8000-0000000f0004', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000e0001', null, 'Broken wire',
   'The wire to the outdoor unit is cut near the window.', 'customer'),
  ('10000000-0000-4000-8000-0000000f0003', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000e0002', '10000000-0000-4000-8000-0000000b0001', 'Inspection visit',
   null, 'business'),
  ('20000000-0000-4000-8000-0000000f0001', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000b0001', 'Fan installation',
   null, 'customer'),
  ('20000000-0000-4000-8000-0000000f0002', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000e0002', null, 'Check tripping main switch', null, 'business');

-- Quotes. Sharma's request #2 has one sent (an inspection visit and a request-level discount, both at 18 % GST),
-- so the job is `quoted`; Kaveri's request #2 has a draft pricing its custom task. Requests #1 are unquoted, for
-- the browser check to quote. A quote is born a draft (the trigger refuses anything else) and its lines can only
-- be written while it is one, so the sent quote is inserted as a draft and then sent. Amounts in paise.
insert into kk.quote (id, business_id, job_id, version, net_minor, tax_minor, total_minor) values
  ('10000000-0000-4000-8000-000000100001', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000e0002', 1, 25000, 4500, 29500),
  ('20000000-0000-4000-8000-000000100001', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000e0002', 1, 35000, 0, 35000);
insert into kk.quote_line (business_id, job_id, quote_id, position, job_task_id, catalogue_item_id, description,
                           unit, quantity_milli, unit_price_minor, tax_rate_bp, net_minor, tax_minor) values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000e0002',
   '10000000-0000-4000-8000-000000100001', 0, '10000000-0000-4000-8000-0000000f0003',
   '10000000-0000-4000-8000-0000000b0001', 'Inspection visit', 'visit', 1000, 30000, 1800, 30000, 5400),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000e0002',
   '10000000-0000-4000-8000-000000100001', 1, null, null, 'Returning customer discount', 'job', 1000, -5000,
   1800, -5000, -900),
  ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-0000000e0002',
   '20000000-0000-4000-8000-000000100001', 0, '20000000-0000-4000-8000-0000000f0002', null,
   'Check tripping main switch', 'visit', 1000, 35000, 0, 35000, 0);
update kk.quote set status = 'sent', sent_at = now(), valid_until = now() + interval '7 days'
  where id = '10000000-0000-4000-8000-000000100001';
update kk.job_task set status = 'quoted' where id = '10000000-0000-4000-8000-0000000f0003';
update kk.job set status = 'quoted' where id = '10000000-0000-4000-8000-0000000e0002';

-- A negotiation that ended in acceptance: Kaveri's request #3 had version 1 (₹472) countered at ₹400, then
-- version 2 with a discount bringing it to ₹400, accepted. Each step is the update the app makes, in order,
-- because the quote trigger allows only those moves. The job is `accepted` and its task `approved`. Signed-in
-- Suresh asked for it at Lakshmi's place, so agreeing the work's time can be tried on his page (3.1b).
insert into kk.job (id, business_id, customer_id, number, source, contact_name, contact_phone_e164, address) values
  ('20000000-0000-4000-8000-0000000e0003', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000c0001', 3, 'public_form', 'Lakshmi Rao', '+919000002002',
   '3 MG Road, Bengaluru');
insert into kk.job_task (id, business_id, job_id, catalogue_item_id, title, added_by) values
  ('20000000-0000-4000-8000-0000000f0003', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000e0003', '20000000-0000-4000-8000-0000000b0001', 'Fan installation', 'customer');
insert into kk.quote (id, business_id, job_id, version, net_minor, tax_minor, total_minor) values
  ('20000000-0000-4000-8000-000000100002', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000e0003', 1, 40000, 7200, 47200);
insert into kk.quote_line (business_id, job_id, quote_id, position, job_task_id, catalogue_item_id, description,
                           unit, quantity_milli, unit_price_minor, tax_rate_bp, net_minor, tax_minor) values
  ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-0000000e0003',
   '20000000-0000-4000-8000-000000100002', 0, '20000000-0000-4000-8000-0000000f0003',
   '20000000-0000-4000-8000-0000000b0001', 'Fan installation', 'unit', 1000, 40000, 1800, 40000, 7200);
update kk.quote set status = 'sent', sent_at = now(), valid_until = now() + interval '7 days'
  where id = '20000000-0000-4000-8000-000000100002';
update kk.job_task set status = 'quoted' where id = '20000000-0000-4000-8000-0000000f0003';
update kk.job set status = 'quoted' where id = '20000000-0000-4000-8000-0000000e0003';
update kk.quote set status = 'countered', decided_at = now(), counter_total_minor = 40000,
                    counter_note = 'Can you do it for 400 all in? I have the fan already.'
  where id = '20000000-0000-4000-8000-000000100002';
insert into kk.quote (id, business_id, job_id, version, net_minor, tax_minor, total_minor) values
  ('20000000-0000-4000-8000-000000100003', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000e0003', 2, 33898, 6102, 40000);
insert into kk.quote_line (business_id, job_id, quote_id, position, job_task_id, catalogue_item_id, description,
                           unit, quantity_milli, unit_price_minor, tax_rate_bp, net_minor, tax_minor) values
  ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-0000000e0003',
   '20000000-0000-4000-8000-000000100003', 0, '20000000-0000-4000-8000-0000000f0003',
   '20000000-0000-4000-8000-0000000b0001', 'Fan installation', 'unit', 1000, 40000, 1800, 40000, 7200),
  ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-0000000e0003',
   '20000000-0000-4000-8000-000000100003', 1, null, null, 'Customer supplies the fan', 'job', 1000, -6102,
   1800, -6102, -1098);
update kk.quote set status = 'superseded' where id = '20000000-0000-4000-8000-000000100002';
update kk.quote set status = 'sent', sent_at = now(), valid_until = now() + interval '7 days'
  where id = '20000000-0000-4000-8000-000000100003';
update kk.quote set status = 'accepted', decided_at = now() where id = '20000000-0000-4000-8000-000000100003';
update kk.job_task set status = 'approved' where id = '20000000-0000-4000-8000-0000000f0003';
update kk.job set status = 'accepted', accepted_quote_id = '20000000-0000-4000-8000-000000100003'
  where id = '20000000-0000-4000-8000-0000000e0003';

-- A planned site visit for Sharma's first request, tomorrow from 10:00 with the technician. Kaveri's accepted
-- request is left unplanned, so scheduling the work can be tried from the app.
insert into kk.appointment (business_id, job_id, kind, technician_member_id, starts_at, ends_at) values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000e0001', 'site_visit',
   '10000000-0000-4000-8000-0000000a0002',
   date_trunc('day', now()) + interval '1 day 10 hours', date_trunc('day', now()) + interval '1 day 11 hours');

-- Work ready to do (4.2): Sharma's request #3, Rahul's AC service, quoted at ₹944, accepted, and its time
-- confirmed for today with the technician, so the job is `scheduled` and Imran can check in, tick the
-- checklist, add photos and complete it.
insert into kk.job (id, business_id, customer_id, number, source, contact_name, contact_phone_e164, address) values
  ('10000000-0000-4000-8000-0000000e0003', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000c0002', 3, 'phone', 'Rahul Joshi', '+919000001002',
   '12 Lane 5, Baner, Pune');
insert into kk.job_task (id, business_id, job_id, catalogue_item_id, title, added_by) values
  ('10000000-0000-4000-8000-0000000f0005', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000e0003', '10000000-0000-4000-8000-0000000b0003', 'AC general service',
   'business');
insert into kk.quote (id, business_id, job_id, version, net_minor, tax_minor, total_minor) values
  ('10000000-0000-4000-8000-000000100002', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000e0003', 1, 80000, 14400, 94400);
insert into kk.quote_line (business_id, job_id, quote_id, position, job_task_id, catalogue_item_id, description,
                           unit, quantity_milli, unit_price_minor, tax_rate_bp, net_minor, tax_minor) values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000e0003',
   '10000000-0000-4000-8000-000000100002', 0, '10000000-0000-4000-8000-0000000f0005',
   '10000000-0000-4000-8000-0000000b0003', 'AC general service', 'unit', 1000, 80000, 1800, 80000, 14400);
update kk.quote set status = 'sent', sent_at = now(), valid_until = now() + interval '7 days'
  where id = '10000000-0000-4000-8000-000000100002';
update kk.quote set status = 'accepted', decided_at = now() where id = '10000000-0000-4000-8000-000000100002';
update kk.job_task set status = 'approved' where id = '10000000-0000-4000-8000-0000000f0005';
insert into kk.appointment (id, business_id, job_id, kind, technician_member_id, starts_at, ends_at) values
  ('10000000-0000-4000-8000-000000120001', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000e0003', 'work', '10000000-0000-4000-8000-0000000a0002',
   date_trunc('day', now()) + interval '9 hours', date_trunc('day', now()) + interval '11 hours');
update kk.job set status = 'scheduled', accepted_quote_id = '10000000-0000-4000-8000-000000100002'
  where id = '10000000-0000-4000-8000-0000000e0003';
