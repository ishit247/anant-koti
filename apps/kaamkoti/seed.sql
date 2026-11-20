-- Development seed, run by `pnpm run up:fresh` as kaamkoti_owner in one transaction. Fixed ids so tests and
-- manual checks can name rows. Two businesses with three customers each, so isolation always has rows on both
-- sides. Phone numbers are in the fictional +91 90000 range; emails use example.com.
-- Grows with the schema: jobs across the states of section 6 arrive in phase 2.
insert into tenancy.business (id, slug, name, phone, city) values
  ('10000000-0000-4000-8000-000000000001', 'sharma-cooling', 'Sharma Cooling Services', '+919000000101', 'Pune'),
  ('20000000-0000-4000-8000-000000000002', 'kaveri-electricals', 'Kaveri Electricals', '+919000000202', 'Bengaluru');

-- identity_id values stand for platform identities (step 0.6 seeds the matching ones in platform).
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
