// Identity: platform is the OpenID Connect provider every app signs people in through (docs/architecture.md 3,
// D13, D14). better-auth does the protocol work; this file decides which of its routes exist, where its tables
// live, how codes are stored and limited, and which clients are registered. Nothing outside this file imports
// better-auth.
import { createHash, createHmac } from "node:crypto";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Logger } from "@bodhchakra/log";
import type { Limit, RateLimitRule } from "@bodhchakra/rate-limit";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";
import { PostgresDialect } from "kysely";
import type pg from "pg";
import type { SignInClients } from "./config.ts";

export const BASE_PATH = "/api/auth";
export const SIGN_IN_PATH = "/sign-in";
export const SCHEMA = "identity";
/** Set by the proxy in front of platform, replacing any value the client sent. */
export const CLIENT_IP_HEADER = "x-client-ip";
export const SCOPES = ["openid", "profile", "email"] as const;

/**
 * The only better-auth routes reachable over HTTP, as `METHOD path` under BASE_PATH. Every other route it ships
 * (client CRUD, consent, passwords, the jwt plugin's /token, ...) answers 404, so a library upgrade that adds a
 * route adds nothing here until it is listed.
 */
export const ROUTES: ReadonlySet<string> = new Set([
  "GET /oauth2/authorize",
  "POST /oauth2/token",
  "GET /oauth2/end-session",
  "GET /jwks",
  "POST /email-otp/send-verification-otp",
  "POST /sign-in/email-otp",
  // Where better-auth sends a browser whose authorize request it cannot hand back to the client.
  "GET /error",
]);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Platform itself on plain HTTP on this machine: development, where the apps' callbacks are plain HTTP too. */
const isDevelopmentOrigin = (origin: string) => {
  const url = new URL(origin);
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
};

const CODE_TTL_SECONDS = 600;
const CODE_ATTEMPTS = 5;

/** Per client IP. Generous for shared mobile-carrier addresses; the per-address limit is the tight one. */
const IP_RULES: Record<string, RateLimitRule> = {
  "/email-otp/send-verification-otp": { window: 3600, max: 10 },
  "/sign-in/email-otp": { window: 600, max: 20 },
  "/oauth2/token": { window: 60, max: 60 },
};
/** Codes sent to one address, whoever asks: at most 5 guesses per code times 5 codes an hour. */
export const ADDRESS_RULE: RateLimitRule = { window: 3600, max: 5 };

export type SendCode = (to: { email: string }, code: string) => Promise<void>;

export interface IdentityDeps {
  /** Connects as platform_app. */
  pool: pg.Pool;
  origin: string;
  secret: string;
  limit: Limit;
  sendCode: SendCode;
}

/**
 * Client secrets are generated, high-entropy values, so a fast hash is enough; it is ours, not better-auth's
 * default, so `registerClients` can write the same value.
 */
const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("base64url");

/** The better-auth configuration. The schema generator uses it too, so the migration matches what runs. */
export function identityOptions(deps: IdentityDeps) {
  return {
    appName: "Bodhchakra",
    baseURL: deps.origin,
    basePath: BASE_PATH,
    secret: deps.secret,
    database: {
      dialect: new PostgresDialect({ pool: deps.pool }),
      type: "postgres",
      schemaName: SCHEMA,
    },
    telemetry: { enabled: false },
    emailAndPassword: { enabled: false },
    rateLimit: {
      enabled: true,
      window: 10,
      max: 100,
      customRules: IP_RULES,
      customStorage: { consume: deps.limit },
    },
    advanced: {
      database: { generateId: "uuid" },
      // better-auth skips its Origin check when it detects a test run; stated here, tests prove what runs.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // `__Host-` needs Secure, Path=/ and no Domain; better-auth's own secure mode would rename to `__Secure-`.
      useSecureCookies: false,
      cookiePrefix: "__Host-id",
    },
    hooks: { before: guardCodeRequests(deps.limit) },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: CODE_TTL_SECONDS,
        allowedAttempts: CODE_ATTEMPTS,
        // Keyed: six digits are a million guesses, so a plain hash read from the table would give the code away.
        storeOTP: {
          hash: async (code) => createHmac("sha256", deps.secret).update(code).digest("hex"),
        },
        sendVerificationOTP: ({ email, otp }) => deps.sendCode({ email }, otp),
      }),
      jwt({ jwt: { issuer: deps.origin } }),
      oauthProvider({
        loginPage: SIGN_IN_PATH,
        consentPage: SIGN_IN_PATH,
        scopes: [...SCOPES],
        requireOpenId: true,
        allowDynamicClientRegistration: false,
        // Redirect URIs must be HTTPS, except to this machine while platform itself is on plain HTTP here.
        allowInsecureRedirectUri: (url: URL) =>
          isDevelopmentOrigin(deps.origin) && LOOPBACK.has(url.hostname),
        storeClientSecret: { hash: async (secret: string) => hashSecret(secret) },
        // The ID token is short-lived: the app reads it once at the callback and keeps its own session.
        idTokenExpiresIn: 300,
        // In the ID token itself, so the app's callback needs no second call to userinfo.
        customIdTokenClaims: ({ user, scopes }) => ({
          ...(scopes.includes("email") && {
            email: user.email,
            email_verified: user.emailVerified,
          }),
          ...(scopes.includes("profile") && { name: user.name }),
        }),
        codeExpiresIn: 180,
      }),
    ],
  } satisfies BetterAuthOptions;
}

/**
 * Before a code is sent: sign-in codes only (the route also sends verification and reset codes; we have neither),
 * and at most ADDRESS_RULE codes to one address, whoever asks.
 */
function guardCodeRequests(limit: Limit) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/email-otp/send-verification-otp") return;
    const body = ctx.body as { email?: unknown; type?: unknown } | undefined;
    if (body?.type !== "sign-in")
      throw new APIError("BAD_REQUEST", { message: "Only sign-in codes are sent" });
    if (typeof body.email !== "string") return; // the route's own validation answers
    const address = createHash("sha256").update(body.email.trim().toLowerCase()).digest("hex");
    const result = await limit(`code-address:${address}`, ADDRESS_RULE);
    if (!result.allowed)
      throw new APIError("TOO_MANY_REQUESTS", { message: "Too many codes for this address" });
  });
}

/**
 * Writes the configured sign-in clients into `identity.oauthClient`, replacing what was there for each id, so
 * config is the one source of truth. A client removed from config is disabled, not deleted, so its issued
 * tokens keep their foreign keys and stop being accepted.
 */
export async function registerClients(pool: pg.Pool, clients: SignInClients): Promise<void> {
  const ids = Object.keys(clients);
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const [id, c] of Object.entries(clients)) {
      await client.query(
        `insert into identity."oauthClient"
           ("id", "clientId", "clientSecret", "name", "redirectUris", "postLogoutRedirectUris", "scopes",
            "grantTypes", "responseTypes", "tokenEndpointAuthMethod", "applicationType", "skipConsent",
            "enableEndSession", "requirePKCE", "disabled", "createdAt", "updatedAt")
         values (gen_random_uuid(), $1, $2, $1, $3, $4, $5, '["authorization_code"]', '["code"]',
                 'client_secret_basic', 'web', true, true, true, false, now(), now())
         on conflict ("clientId") do update set
           "clientSecret" = excluded."clientSecret", "redirectUris" = excluded."redirectUris",
           "postLogoutRedirectUris" = excluded."postLogoutRedirectUris", "scopes" = excluded."scopes",
           "disabled" = false, "updatedAt" = now()`,
        [
          id,
          hashSecret(c.secret),
          JSON.stringify(c.redirectUris),
          JSON.stringify(c.postLogoutRedirectUris),
          JSON.stringify(SCOPES),
        ],
      );
    }
    await client.query(
      `update identity."oauthClient" set "disabled" = true, "updatedAt" = now() where not ("clientId" = any($1))`,
      [ids],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw new Error("registering sign-in clients failed", { cause: error });
  } finally {
    client.release();
  }
}

export interface Identity {
  /** Serves BASE_PATH/*, the sign-in page and discovery; null for any other path. */
  handle(request: Request, url: URL): Promise<Response> | null;
}

export function createIdentity(deps: IdentityDeps, log: Logger): Identity {
  const auth = betterAuth(identityOptions(deps));

  return {
    handle(request, url) {
      const path = url.pathname;
      if (path === "/.well-known/openid-configuration" && request.method === "GET")
        return auth.api.getOpenIdConfig().then((config) => Response.json(config));
      if (path === SIGN_IN_PATH && request.method === "GET") return Promise.resolve(signInPage());
      if (!path.startsWith(`${BASE_PATH}/`)) return null;
      const route = `${request.method} ${path.slice(BASE_PATH.length)}`;
      if (!ROUTES.has(route))
        return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
      return auth.handler(request).then((response) => {
        if (response.status >= 500)
          log.error("identity route failed", { route, status: response.status });
        return response;
      });
    },
  };
}

// The sign-in page, for members and customers alike (asked 2026-11-22, from a sketch): the email and "Get code",
// then the code and "Sign in" below the same email. It posts to better-auth's routes with the signed authorize
// query, and better-auth answers with the client's redirect once the session exists. No framework: this is the
// one page. The field becomes "Email or mobile" when phone sign-in arrives (3.3).
const SIGN_IN_SCRIPT = `
const q = location.search.slice(1);
const form = document.querySelector("form");
const email = form.elements.email, code = form.elements.code, go = form.querySelector("button[type=submit]");
const step = document.getElementById("code-step"), change = document.getElementById("change");
const note = document.querySelector("output");
const post = (path, body) => fetch("${BASE_PATH}" + path, {
  method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
  body: JSON.stringify(body),
});
const busy = (label) => { go.disabled = label !== null; go.textContent = label ?? (step.hidden ? "Get code" : "Sign in"); };
change.addEventListener("click", () => {
  step.hidden = true; code.required = false; code.value = ""; email.readOnly = false;
  note.textContent = ""; busy(null); email.focus();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  note.textContent = "";
  if (step.hidden) {
    busy("Sending…");
    const sent = await post("/email-otp/send-verification-otp", { email: email.value, type: "sign-in" }).catch(() => null);
    if (!sent?.ok) {
      busy(null);
      note.textContent = sent?.status === 429 ? "Too many codes. Try again later." : "Could not send a code. Try again.";
      return;
    }
    step.hidden = false; code.required = true; email.readOnly = true; busy(null); code.focus();
    note.textContent = "We sent a 6-digit code to " + email.value + ".";
    return;
  }
  busy("Signing in…");
  const signedIn = await post("/sign-in/email-otp", { email: email.value, otp: code.value, oauth_query: q }).catch(() => null);
  const body = await signedIn?.json().catch(() => ({}));
  if (signedIn?.ok && body?.url) { location.assign(body.url); return; }
  busy(null);
  note.textContent = "That code did not work. Check it, or ask for a new one.";
});
`;
const SIGN_IN_SCRIPT_HASH = createHash("sha256").update(SIGN_IN_SCRIPT).digest("base64");

const SIGN_IN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c1b1a;background:#f6f3ee}
main{max-width:24rem;margin:0 auto;padding:12vh 1rem 2rem}
h1{font-size:1.75rem;line-height:1.25;letter-spacing:-.01em;margin:0 0 .25rem}
p{margin:0}.muted{color:#5c5750}
form{display:grid;gap:.9rem;margin-top:1.5rem;padding:1.1rem;background:#fff;border:1px solid #ebe5dc;border-radius:1rem;
box-shadow:0 1px 2px rgb(28 27 26/.05),0 6px 20px rgb(28 27 26/.06)}
[hidden]{display:none!important}
label{display:grid;gap:.3rem;font-weight:600;font-size:.9rem}
input{width:100%;min-height:3rem;padding:.6rem .8rem;font:inherit;font-weight:400;color:inherit;background:#f4f0ea;
border:1px solid #ddd5ca;border-radius:.8rem}
input:focus{outline:none;background:#fff;border-color:#b4411c;box-shadow:0 0 0 3px #fbe9e2}
input[readonly]{color:#5c5750}
input[name=code]{font-size:1.25rem;letter-spacing:.3em}
button{min-height:3rem;width:100%;font:inherit;font-weight:600;color:#fff;background:#b4411c;border:0;border-radius:.8rem;cursor:pointer}
button:hover{background:#8f3213}button:disabled{opacity:.6;cursor:progress}
button.link{min-height:2.75rem;width:auto;justify-self:start;padding:0 .25rem;color:#8f3213;background:none}
button.link:hover{text-decoration:underline}
:focus-visible{outline:2px solid #b4411c;outline-offset:2px}
output{color:#5c5750;font-size:.9rem}output:empty{display:none}
</style>
</head><body><main><h1>Sign in</h1><p class="muted">We send a code, no password needed.</p>
<form><label>Email<input name="email" type="email" autocomplete="email" inputmode="email" required></label>
<div id="code-step" hidden><label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="6 digits"></label>
<button type="button" class="link" id="change">Use another email</button></div>
<button type="submit">Get code</button><output role="status"></output></form></main>
<script>${SIGN_IN_SCRIPT}</script></body></html>`;

function signInPage(): Response {
  return new Response(SIGN_IN_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'sha256-${SIGN_IN_SCRIPT_HASH}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** Builds a better-auth instance only to compile its schema; never serves a request. */
export async function compileIdentitySchema(pool: pg.Pool): Promise<string> {
  const { getMigrations } = await import("better-auth/db/migration");
  const unused = async () => {
    throw new Error("compileIdentitySchema: not for serving");
  };
  const { compileMigrations } = await getMigrations(
    identityOptions({
      pool,
      origin: "http://localhost",
      secret: "x".repeat(48),
      limit: unused,
      sendCode: unused,
    }),
  );
  return compileMigrations();
}
