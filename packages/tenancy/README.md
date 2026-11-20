# @bodhchakra/tenancy

The tenant (a business), its members, roles and invites, and the scope-check helpers. Layer: domain. Design:
[docs/architecture.md](../../docs/architecture.md) section 4.

Built so far (step 0.3): the `tenancy.business` table and the `migrations` folder export, so the app can seed
businesses. Members, invites, RLS, `resolve_slug`, the scope helpers, the route-scope test kit and the runtime
role's rights arrive in step 0.4.

## API

| Export       | What it is                                                      |
| ------------ | --------------------------------------------------------------- |
| `migrations` | The module's `MigrationFolder`; an app lists it before its own. |

## Tables

| Table              | Columns                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `tenancy.business` | `id`, `slug` (unique), `name`, `phone` (E.164), `city`, `timezone` (default `Asia/Kolkata`), `currency` (default `INR`), `created_at` |
