# @bodhchakra/tenancy

The tenant (a business), its members and roles, the permission check, and the route-scope declarations with the
test kit that finds undeclared routes. Layer: domain. Design: [docs/architecture.md](../../docs/architecture.md)
section 4.

Invites (`createInvite`, `acceptInvite`, `tenancy.invite`) arrive in step 0.7, once `tokens` exists (0.5).

## API

| Export                                                               | What it does                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `createBusiness(db, business, owner)`                                | Creates the business and its owner member in one `withTenant` of the new id. Returns the owner's `Membership`.     |
| `addMember(client, member)`                                          | Adds a member, inside `withTenant` of that business. Returns the `Membership`.                                     |
| `membershipsOf(client, identityId)`                                  | The identity's current memberships, oldest first. Needs no tenant (sign-in uses it to choose the business).        |
| `resolveSlug(client, slug)`                                          | The business id for a public slug, or `null`. Needs no tenant (public pages use it to open one).                   |
| `requireRole(membership, ...roles)`                                  | The permission check. Throws `NotPermittedError` (`code: "not_permitted"`) if the role is not listed.              |
| `defineRoute(declaration)`                                           | Each route file exports `export const route = defineRoute({ scope, … })`. A `member` route also lists its `roles`. |
| `scanRoutes(dir)`                                                    | The test kit: `{ routes, undeclared }` for every page, layout, route handler and `"use server"` file under `dir`.  |
| `Role`, `ROLES`, `Scope`, `SCOPES`, `Membership`, `RouteDeclaration` | Types and their value lists.                                                                                       |
| `migrations`                                                         | The module's `MigrationFolder`; an app lists it before its own.                                                    |

An app's route test (from step 0.7, when the first route exists):

```ts
const { routes, undeclared } = await scanRoutes(new URL("../src/app/", import.meta.url));
expect(routes.length).toBeGreaterThan(0); // the wrong directory fails instead of passing
expect(undeclared).toEqual([]);
```

## Rules it enforces

- **Business scope is RLS.** `tenancy.business` (by `id`) and `tenancy.member` (by `business_id`) are visible and
  writable only inside `withTenant` of that business. Without a tenant the runtime role sees nothing.
- **No deletes.** The runtime role has select, insert and update; a member leaves through `removed_at`.
- **One owner per business** (partial unique index).
- **Two entry points need no tenant**, and return only what opens one: `tenancy.resolve_slug` (an id) and
  `tenancy.memberships_of` (the identity's current memberships). Both are `security definer` with an empty
  `search_path`, executable by the runtime role only.
- **Permission is not scope.** `requireRole` answers _what_; RLS and the scope declaration answer _whose_.

## Tables

| Table              | Columns                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `tenancy.business` | `id`, `slug` (unique), `name`, `phone` (E.164), `city`, `timezone` (default `Asia/Kolkata`), `currency` (default `INR`), `created_at` |
| `tenancy.member`   | `id`, `business_id`, `identity_id` (platform identity), `display_name`, `role` (`owner`, `technician`), `removed_at`, `created_at`    |

## Tests

`pnpm --filter @bodhchakra/tenancy test` against the dev Postgres (`pnpm run up` first). Route fixtures are in
`test/fixtures/routes/`.
