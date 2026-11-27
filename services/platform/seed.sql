-- Development seed, run by `pnpm run up:fresh` as platform_owner in one transaction. The identities behind the
-- members in apps/kaamkoti/seed.sql, with the same ids, so signing in as one of these addresses (code in Mailpit,
-- http://127.0.0.1:45446) opens that member's business. Emails use example.com.
insert into identity."user" (id, name, email, "emailVerified") values
  ('00000000-0000-4000-8000-00000000d001', 'Prakash Sharma', 'prakash@example.com', true),
  ('00000000-0000-4000-8000-00000000d002', 'Imran Shaikh', 'imran@example.com', true),
  ('00000000-0000-4000-8000-00000000d003', 'Kavya Reddy', 'kavya@example.com', true),
  ('00000000-0000-4000-8000-00000000d004', 'Manjunath B', 'manjunath@example.com', true),
  -- Customers (D15): the signed-in customers of Sharma and of Kaveri in apps/kaamkoti/seed.sql.
  ('00000000-0000-4000-8000-00000000d005', 'Anita Deshpande', 'anita@example.com', true),
  ('00000000-0000-4000-8000-00000000d006', 'Suresh Gowda', 'suresh@example.com', true);

-- Billing (docs/architecture.md 13): the owners of the two businesses in apps/kaamkoti/seed.sql are the payers.
-- Sharma is in its Team trial; Kaveri pays for Team with two people (a Razorpay subscription in the dev stand-in's
-- form). The app's copies in that seed carry the same state and version.
insert into billing.account (id, identity_id) values
  ('00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-00000000d001'),
  ('00000000-0000-4000-8000-0000000b0003', '00000000-0000-4000-8000-00000000d003');
insert into billing.subscription (account_id, product, tenant_id, plan, seats, status, trial_ends_at, paid_through,
                                  provider_subscription_id, provider_event_at, version) values
  ('00000000-0000-4000-8000-0000000b0001', 'kaamkoti', '10000000-0000-4000-8000-000000000001', 'team', 1,
   'trialing', date_trunc('day', now()) + interval '10 days', null, null, null, 1),
  ('00000000-0000-4000-8000-0000000b0003', 'kaamkoti', '20000000-0000-4000-8000-000000000002', 'team', 2,
   'active', date_trunc('day', now()) - interval '10 days', date_trunc('day', now()) + interval '20 days',
   'sub_SeedKaveri01', date_trunc('day', now()) - interval '10 days', 2);
