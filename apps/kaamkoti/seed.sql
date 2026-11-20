-- Development seed, run by `pnpm run up:fresh` as kaamkoti_owner in one transaction. Fixed ids so tests and
-- manual checks can name rows. Two businesses with three customers each, so isolation always has rows on both
-- sides. Phone numbers are in the fictional +91 90000 range; emails use example.com.
-- Grows with the schema: two new requests per business now; jobs across the other states of section 6 arrive
-- with the steps that move them there.
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

insert into kk.customer (id, business_id, name, phone_e164, email, address) values
  ('10000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-000000000001',
   'Anita Deshpande', '+919000001001', 'anita@example.com', 'Flat 4, Shanti Apartments, Kothrud, Pune'),
  ('10000000-0000-4000-8000-0000000c0002', '10000000-0000-4000-8000-000000000001',
   'Rahul Joshi', '+919000001002', null, '12 Lane 5, Baner, Pune'),
  ('10000000-0000-4000-8000-0000000c0003', '10000000-0000-4000-8000-000000000001',
   'Meera Kulkarni', '+919000001003', 'meera@example.com', null),
  ('20000000-0000-4000-8000-0000000c0001', '20000000-0000-4000-8000-000000000002',
   'Suresh Gowda', '+919000002001', 'suresh@example.com', '88 4th Cross, Jayanagar, Bengaluru'),
  ('20000000-0000-4000-8000-0000000c0002', '20000000-0000-4000-8000-000000000002',
   'Lakshmi Rao', '+919000002002', null, '3 MG Road, Bengaluru'),
  -- Same phone as a Sharma customer: one person can be a customer of two businesses.
  ('20000000-0000-4000-8000-0000000c0003', '20000000-0000-4000-8000-000000000002',
   'Anita Deshpande', '+919000001001', null, null);

-- Both businesses are onboarded. Sharma started from the ac_repair template (as startFromTemplate would copy it);
-- Kaveri built its own list, so it has no template of its own. Prices are in paise, tax in basis points.
insert into kk.business_profile (business_id, trade_key, about, service_area, intake, checklist, terms) values
  ('10000000-0000-4000-8000-000000000001', 'ac_repair', 'AC and appliance repair across Pune since 2012.',
   'Pune, Pimpri-Chinchwad', '[]', '[{"key":"power_off","label":"Power isolated before opening"}]',
   'Quote is valid for 7 days. Parts replaced carry a 30-day warranty. Payment is due on completion.'),
  ('20000000-0000-4000-8000-000000000002', 'electrician', '', 'Bengaluru south', '[]', '[]',
   'Payment is due on completion.');

insert into kk.catalogue_item (id, business_id, name, unit, unit_price_minor, tax_rate_bp, position) values
  ('10000000-0000-4000-8000-0000000b0001', '10000000-0000-4000-8000-000000000001', 'Inspection visit', 'visit', 30000, 1800, 0),
  ('10000000-0000-4000-8000-0000000b0002', '10000000-0000-4000-8000-000000000001', 'AC gas refill', 'unit', 250000, 1800, 1),
  ('10000000-0000-4000-8000-0000000b0003', '10000000-0000-4000-8000-000000000001', 'AC general service', 'unit', 80000, 1800, 2),
  ('20000000-0000-4000-8000-0000000b0001', '20000000-0000-4000-8000-000000000002', 'Fan installation', 'unit', 40000, 1800, 0),
  ('20000000-0000-4000-8000-0000000b0002', '20000000-0000-4000-8000-000000000002', 'House rewiring', 'sq_ft', 9000, 1800, 1);

insert into kk.job (id, business_id, customer_id, number, source) values
  ('10000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000c0001', 1, 'public_form'),
  ('10000000-0000-4000-8000-0000000e0002', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-0000000c0002', 2, 'phone'),
  ('20000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000c0001', 1, 'public_form'),
  ('20000000-0000-4000-8000-0000000e0002', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-0000000c0003', 2, 'phone');

-- One customer link per business to its request #1, with a fixed development secret (stored, as always, only
-- as its SHA-256) so manual and browser checks can open /j/<secret>. Real links come from issueJobLink.
insert into tokens.token (hash, purpose, business_id, subject_id, expires_at) values
  (sha256(convert_to('dev-job-link-sharma-request-1-xxxxxxxxxxxxx', 'UTF8')), 'job',
   '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000e0001', now() + interval '30 days'),
  (sha256(convert_to('dev-job-link-kaveri-request-1-xxxxxxxxxxxxx', 'UTF8')), 'job',
   '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-0000000e0001', now() + interval '30 days');
