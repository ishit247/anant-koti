-- Development seed, run by `pnpm run up:fresh` as platform_owner in one transaction. The identities behind the
-- members in apps/kaamkoti/seed.sql, with the same ids, so signing in as one of these addresses (code in Mailpit,
-- http://127.0.0.1:45446) opens that member's business. Emails use example.com.
insert into identity."user" (id, name, email, "emailVerified") values
  ('00000000-0000-4000-8000-00000000d001', 'Prakash Sharma', 'prakash@example.com', true),
  ('00000000-0000-4000-8000-00000000d002', 'Imran Shaikh', 'imran@example.com', true),
  ('00000000-0000-4000-8000-00000000d003', 'Kavya Reddy', 'kavya@example.com', true),
  ('00000000-0000-4000-8000-00000000d004', 'Manjunath B', 'manjunath@example.com', true);
