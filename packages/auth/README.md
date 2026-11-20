# @bodhchakra/auth

The app side of sign-in: an OpenID Connect client of `platform` (authorization code + PKCE) and the app's own
sessions. Layer: domain (uses `tenancy`). Design: [docs/architecture.md](../../docs/architecture.md) section 3.
The app never imports better-auth; ID tokens are verified with `jose`.

## API

| Export                                     | What it does                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAuth(options)`                      | Returns `Auth`. Options: `db` (runtime role), `log`, `issuer` (public `id.` origin), `internalUrl` (platform on the internal network), `clientId`, `clientSecret`, `redirectUri`, `postLogoutRedirectUri`, `cookiePrefix`. |
| `auth.startLogin(returnTo?)`               | For `GET /login`. Returns `{ location, setCookie }`: redirect to platform's authorize and set the login cookie. `returnTo` passes through `safeReturnTo`.                                                                  |
| `auth.handleCallback(query, cookieHeader)` | For `GET /auth/callback`. Returns `{ session, identity: { email, name }, returnTo, setCookies }`. Throws `SignInRefused` (show "start again") or `SignInUnavailable` (platform down).                                      |
| `auth.getSession(cookieHeader)`            | `{ identityId, memberships }` or null. Restarts the idle clock at most once an hour.                                                                                                                                       |
| `auth.signOut(cookieHeader)`               | Deletes the session. Returns `{ location, setCookie }`: platform's end-session (which ends its session too and returns to `postLogoutRedirectUri`), or straight home if there was no session.                              |
| `auth.sessionCookie`                       | The session cookie's name, e.g. `__Host-kk_session`.                                                                                                                                                                       |
| `safeReturnTo(path)`                       | A same-origin path, or `/`.                                                                                                                                                                                                |
| `migrations`                               | List after `tenancy`.                                                                                                                                                                                                      |

`cookieHeader` is the request's `Cookie` header as it arrived. The functions return `Set-Cookie` values for the
caller to send; they never touch a response themselves.

## Rules it enforces

- **A callback finishes only the sign-in this browser started.** The attempt is read and deleted in one
  statement, committed before the code is exchanged: a replay finds nothing. The `__Host-<prefix>_login` cookie
  must carry the callback's `state`.
- **The ID token is platform's, for this app, for this attempt, and fresh.** Signature against platform's JWKS
  (EdDSA only), `iss`, `aud`, `exp`, `iat` no older than 5 minutes, `nonce`, `email_verified`, and a uuid `sub`.
- **Sessions:** a random 32-byte token in the cookie, its SHA-256 in the table. 30 days absolute, 7 days idle.
  Cookies are `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`.
- **Platform down:** existing sessions keep working (local rows); a new sign-in throws `SignInUnavailable`.
- **No job needed:** expired attempts are deleted when a sign-in starts, expired sessions when one finishes.
- Refusals are logged with a reason; tokens, codes and addresses are not.

## Tables

`auth.login_attempt`: `state` (primary key), `nonce`, `code_verifier`, `return_to`, `expires_at`. The runtime
role may select, insert and delete.

`auth.session`: `token_hash` (primary key), `identity_id`, `id_token` (the hint platform's end-session needs),
`expires_at`, `last_seen_at`. The runtime role may select, insert, update and delete; truncate is revoked.

Neither has RLS: they turn a callback or a cookie into an identity, which finds its businesses through
`tenancy.memberships_of`.

## Tests

`pnpm --filter @bodhchakra/auth test` (forged, mismatched and replayed responses against a stand-in platform).
The full flow against the real platform: `apps/kaamkoti/test/sign-in.test.ts`. Both need `pnpm run up`.
