// The app side of sign-in (docs/architecture.md 3): an OpenID Connect client of platform (authorization code
// + PKCE), and the app's own sessions. The ID token is verified with jose, never by hand. Everything the app
// trusts about a person after sign-in comes from a verified ID token or from a local session row.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@bodhchakra/db";
import type { Logger } from "@bodhchakra/log";
import { type Membership, membershipsOf } from "@bodhchakra/tenancy";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";

/** Platform's identity routes (services/platform/src/identity.ts). */
const AUTHORIZE_PATH = "/api/auth/oauth2/authorize";
const TOKEN_PATH = "/api/auth/oauth2/token";
const JWKS_PATH = "/api/auth/jwks";
const END_SESSION_PATH = "/api/auth/oauth2/end-session";
/** What platform signs with (better-auth's jwt plugin default). Any other algorithm is refused. */
const ALGORITHMS = ["EdDSA"];

const ATTEMPT_MINUTES = 10;
const SESSION_DAYS = 30;
const IDLE_DAYS = 7;
/** last_seen_at is moved at most this often, so reading a session is not a write on every request. */
const TOUCH_MINUTES = 60;
const NETWORK_TIMEOUT_MS = 10_000;

export interface AuthOptions {
  /** Connects as the app's runtime role. */
  db: Db;
  log: Logger;
  /** Public origin of the sign-in host (`https://id.<platform-tld>`): where browsers go, and the ID token's `iss`. */
  issuer: string;
  /** Platform as the app reaches it on the internal network, e.g. `http://platform:3000`: code exchange, JWKS. */
  internalUrl: string;
  clientId: string;
  clientSecret: string;
  /** This app's `/auth/callback`, as registered with platform. */
  redirectUri: string;
  /** Where platform sends the browser after signing out, as registered with platform. */
  postLogoutRedirectUri: string;
  /** `kk` names the cookies `__Host-kk_session` and `__Host-kk_login`. */
  cookiePrefix: string;
}

/** A signed-in person: the platform identity, and the businesses it is a member of here. */
export interface Session {
  readonly identityId: string;
  readonly memberships: readonly Membership[];
}

export interface SignedIn {
  readonly session: Session;
  /** From the ID token, for onboarding; not stored here (personal data lives in platform). */
  readonly identity: { readonly email: string; readonly name: string };
  /** A path on this app, checked: never another origin. */
  readonly returnTo: string;
  /** Set the session cookie and clear the login cookie. */
  readonly setCookies: readonly string[];
}

export interface Redirect {
  readonly location: string;
  readonly setCookie: string;
}

/** The sign-in response was not one this app asked for, or did not verify. The person starts again. */
export class SignInRefused extends Error {
  readonly code = "sign_in_refused";
  constructor(reason: string) {
    super(`sign-in refused: ${reason}`);
    this.name = "SignInRefused";
  }
}

/** Platform could not be reached or failed. "Sign-in is briefly unavailable"; existing sessions still work. */
export class SignInUnavailable extends Error {
  readonly code = "sign_in_unavailable";
  constructor(reason: string, options?: { cause: unknown }) {
    super(`sign-in unavailable: ${reason}`, options);
    this.name = "SignInUnavailable";
  }
}

export interface Auth {
  readonly sessionCookie: string;
  /** For `GET /login`: records the attempt and sends the browser to platform. */
  startLogin(returnTo?: string | null): Promise<Redirect>;
  /**
   * For `GET /auth/callback`. Throws SignInRefused for any response this browser did not start, a used or
   * expired attempt, or an ID token that does not verify; SignInUnavailable if platform cannot be reached.
   */
  handleCallback(query: URLSearchParams, cookieHeader: string | null): Promise<SignedIn>;
  /** The session the request's cookie names, or null; a live session's idle clock restarts. */
  getSession(cookieHeader: string | null): Promise<Session | null>;
  /** Ends the local session and sends the browser to platform to end the platform one too. */
  signOut(cookieHeader: string | null): Promise<Redirect>;
}

const random = () => randomBytes(32).toString("base64url");
const sha256 = (value: string) => createHash("sha256").update(value).digest();
/** 32 random bytes in base64url, as `random` makes them. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const tokenResponse = z.object({ id_token: z.string().min(1) });
const idTokenClaims = z.object({
  sub: z.uuid(),
  nonce: z.string(),
  email: z.email(),
  // Platform signs in by a code sent to the address, so it is always verified; anything else is not ours.
  email_verified: z.literal(true),
  name: z.string(),
});

/** A same-origin path, or `/`. Stops `/login?return=//evil.example` sending the person elsewhere. */
export function safeReturnTo(path: string | null | undefined): string {
  if (!path || path.length > 2048 || !path.startsWith("/") || path.includes("\\")) return "/";
  const base = "http://app.invalid";
  const url = new URL(path, base);
  return url.origin === base ? url.pathname + url.search + url.hash : "/";
}

/** The value of the first cookie called `name` in a Cookie header. */
function readCookie(header: string | null, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** `__Host-` cookies: Secure, Path=/, no Domain, so only this exact host ever receives them. */
const cookie = (name: string, value: string, maxAgeSeconds: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;

export function createAuth(options: AuthOptions): Auth {
  const { db, log } = options;
  const sessionCookie = `__Host-${options.cookiePrefix}_session`;
  const loginCookie = `__Host-${options.cookiePrefix}_login`;
  // jose caches the keys and refetches only for an unknown key id, with a cooldown.
  const jwks = createRemoteJWKSet(new URL(JWKS_PATH, options.internalUrl), {
    timeoutDuration: NETWORK_TIMEOUT_MS,
  });

  async function exchange(code: string, verifier: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(new URL(TOKEN_PATH, options.internalUrl), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: options.redirectUri,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SignInUnavailable("token endpoint unreachable", { cause: error });
    }
    if (response.status >= 500)
      throw new SignInUnavailable(`token endpoint answered ${response.status}`);
    if (!response.ok) throw new SignInRefused(`token endpoint answered ${response.status}`);
    const body = tokenResponse.safeParse(await response.json().catch(() => null));
    if (!body.success) throw new SignInRefused("token response has no ID token");
    return body.data.id_token;
  }

  async function verify(idToken: string, nonce: string) {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(idToken, jwks, {
        issuer: options.issuer,
        audience: options.clientId,
        algorithms: ALGORITHMS,
        requiredClaims: ["sub", "iat", "exp", "nonce"],
        // Platform issues ID tokens for 5 minutes; an older iat is not a token from this sign-in.
        maxTokenAge: "5m",
        clockTolerance: 30,
      }));
    } catch (error) {
      // Not a JOSE error, or a JWKS timeout: the key set could not be fetched, which is platform, not the token.
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError))
        throw new SignInUnavailable("JWKS unreachable", { cause: error });
      throw new SignInRefused(`ID token does not verify (${error.code})`);
    }
    const claims = idTokenClaims.safeParse(payload);
    if (!claims.success) throw new SignInRefused("ID token claims are not as expected");
    if (claims.data.nonce !== nonce) throw new SignInRefused("ID token nonce does not match");
    return claims.data;
  }

  async function callback(query: URLSearchParams, cookieHeader: string | null): Promise<SignedIn> {
    const state = query.get("state");
    if (!state || !TOKEN.test(state)) throw new SignInRefused("no state");
    // Read and deleted in one statement, and committed before anything else: whatever follows, this attempt
    // can never finish a second sign-in.
    const { rows } = await db.tx((client) =>
      client.query<{ nonce: string; code_verifier: string; return_to: string; live: boolean }>(
        `delete from auth.login_attempt where state = $1
         returning nonce, code_verifier, return_to, expires_at > now() as live`,
        [state],
      ),
    );
    const attempt = rows[0];
    if (!attempt) throw new SignInRefused("unknown or used state");
    if (!attempt.live) throw new SignInRefused("attempt expired");
    // Bound to the browser that started it, so nobody can finish their own sign-in in someone else's browser.
    if (readCookie(cookieHeader, loginCookie) !== state)
      throw new SignInRefused("attempt was started in another browser");
    if (query.has("error")) throw new SignInRefused("platform answered with an error");
    const code = query.get("code");
    if (!code) throw new SignInRefused("no code");

    const idToken = await exchange(code, attempt.code_verifier);
    const claims = await verify(idToken, attempt.nonce);

    const token = random();
    const memberships = await db.tx(async (client) => {
      await client.query(
        `delete from auth.session
         where expires_at <= now() or last_seen_at <= now() - make_interval(days => $1)`,
        [IDLE_DAYS],
      );
      await client.query(
        `insert into auth.session (token_hash, identity_id, id_token, expires_at)
         values ($1, $2, $3, now() + make_interval(days => $4))`,
        [sha256(token), claims.sub, idToken, SESSION_DAYS],
      );
      return membershipsOf(client, claims.sub);
    });
    return {
      session: { identityId: claims.sub, memberships },
      identity: { email: claims.email, name: claims.name },
      returnTo: attempt.return_to,
      setCookies: [cookie(sessionCookie, token, SESSION_DAYS * 86_400), cookie(loginCookie, "", 0)],
    };
  }

  return {
    sessionCookie,

    async startLogin(returnTo) {
      const state = random();
      const nonce = random();
      const verifier = random();
      await db.tx(async (client) => {
        await client.query("delete from auth.login_attempt where expires_at <= now()");
        await client.query(
          `insert into auth.login_attempt (state, nonce, code_verifier, return_to, expires_at)
           values ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
          [state, nonce, verifier, safeReturnTo(returnTo), ATTEMPT_MINUTES],
        );
      });
      const url = new URL(AUTHORIZE_PATH, options.issuer);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: sha256(verifier).toString("base64url"),
        code_challenge_method: "S256",
      }).toString();
      return { location: url.href, setCookie: cookie(loginCookie, state, ATTEMPT_MINUTES * 60) };
    },

    async handleCallback(query, cookieHeader) {
      try {
        return await callback(query, cookieHeader);
      } catch (error) {
        if (error instanceof SignInRefused) log.warn("sign-in refused", { reason: error.message });
        else if (error instanceof SignInUnavailable)
          log.error("sign-in unavailable", { reason: error.message, error: error.cause });
        throw error;
      }
    },

    async getSession(cookieHeader) {
      const token = readCookie(cookieHeader, sessionCookie);
      if (!token || !TOKEN.test(token)) return null;
      return db.tx(async (client) => {
        const { rows } = await client.query<{ identity_id: string; stale: boolean }>(
          `select identity_id, last_seen_at <= now() - make_interval(mins => $3) as stale
           from auth.session
           where token_hash = $1 and expires_at > now() and last_seen_at > now() - make_interval(days => $2)`,
          [sha256(token), IDLE_DAYS, TOUCH_MINUTES],
        );
        const row = rows[0];
        if (!row) return null;
        if (row.stale)
          await client.query("update auth.session set last_seen_at = now() where token_hash = $1", [
            sha256(token),
          ]);
        return {
          identityId: row.identity_id,
          memberships: await membershipsOf(client, row.identity_id),
        };
      });
    },

    async signOut(cookieHeader) {
      const token = readCookie(cookieHeader, sessionCookie);
      const setCookie = cookie(sessionCookie, "", 0);
      if (!token || !TOKEN.test(token))
        return { location: options.postLogoutRedirectUri, setCookie };
      const { rows } = await db.tx((client) =>
        client.query<{ id_token: string }>(
          "delete from auth.session where token_hash = $1 returning id_token",
          [sha256(token)],
        ),
      );
      const idToken = rows[0]?.id_token;
      if (!idToken) return { location: options.postLogoutRedirectUri, setCookie };
      const url = new URL(END_SESSION_PATH, options.issuer);
      url.search = new URLSearchParams({
        id_token_hint: idToken,
        client_id: options.clientId,
        post_logout_redirect_uri: options.postLogoutRedirectUri,
      }).toString();
      return { location: url.href, setCookie };
    },
  };
}
