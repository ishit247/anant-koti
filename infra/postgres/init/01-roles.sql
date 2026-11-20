-- Runs once, on an empty dev volume (docker-entrypoint-initdb.d). DEV passwords, each equal to its role name and
-- public in the repository; on the server the shared infra provisioning creates these roles with real secrets.
-- kaamkoti_owner owns the database and every object in it and is used only to migrate and seed.
-- kaamkoti_app is the runtime role (web and worker): it owns nothing, cannot bypass RLS, and gets its rights
-- only from the migrations' explicit GRANTs (docs/architecture.md, section 2).
create role kaamkoti_owner login password 'kaamkoti_owner';
alter database kaamkoti owner to kaamkoti_owner;
create role kaamkoti_app login nobypassrls password 'kaamkoti_app';

revoke connect on database kaamkoti from public;
grant connect on database kaamkoti to kaamkoti_app;
