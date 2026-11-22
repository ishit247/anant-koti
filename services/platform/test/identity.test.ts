// Sign-in through platform's OpenID Connect provider, over real HTTP, against real Postgres and Redis
// (docs/architecture.md 3). The app side of the flow is played by this test; 0.6b builds it for real.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { type Limiter, redisLimiter } from "@bodhchakra/rate-limit";
import { createLocalJWKSet, jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_IP_HEADER, createIdentity, registerClients } from "../src/identity.ts";
import { migrations, RUNTIME_ROLE } from "../src/index.ts";
import { createHandler, listen } from "../src/server.ts";
import { identitySql } from "./identity-sql.ts";

const CLIENT = "kaamkoti";
const CLIENT_SECRET = "kaamkoti-sign-in-test-secret-".padEnd(48, "x");
const REDIRECT_URI = "https://app.kaamkoti.test/auth/callback";
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:45444";

const base64url = (bytes: Buffer) => bytes.toString("base64url");

describe("identity", () => {
  let db: TestDb;
  let pool: pg.Pool;
  let limiter: Limiter;
  let server: Server;
  let origin: string;
  /** Codes sent, by address. */
  const codes = new Map<string, string>();
  /** One per run, so earlier runs' counters in Redis do not count against this one. */
  const ip = `10.${randomBytes(3).join(".")}`;
  const log = createLogger({ service: "test", write: () => undefined });

  beforeAll(async () => {
    db = await testDb({ owner: "platform_owner", runtimeRole: RUNTIME_ROLE, folders: migrations });
    pool = new pg.Pool({ connectionString: db.url(RUNTIME_ROLE), max: 3 });
    limiter = redisLimiter(REDIS_URL, log);
    await registerClients(pool, {
      [CLIENT]: {
        secret: CLIENT_SECRET,
        redirectUris: [REDIRECT_URI],
        postLogoutRedirectUris: [REDIRECT_URI],
      },
      retired: {
        secret: CLIENT_SECRET,
        redirectUris: [REDIRECT_URI],
        postLogoutRedirectUris: [REDIRECT_URI],
      },
    });
    // Dropped from config: kept, but disabled.
    await registerClients(pool, {
      [CLIENT]: {
        secret: CLIENT_SECRET,
        redirectUris: [REDIRECT_URI],
        postLogoutRedirectUris: [REDIRECT_URI],
      },
    });

    let handler: (request: Request) => Promise<Response> = () =>
      Promise.reject(new Error("not ready"));
    server = await listen((request) => handler(request), log, 0, "127.0.0.1");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const identity = createIdentity(
      {
        pool,
        origin,
        secret: "identity-test-secret-".padEnd(48, "y"),
        limit: limiter.limit,
        sendCode: async (to, code) => {
          codes.set(to.email, code);
        },
      },
      log,
    );
    handler = createHandler({
      db: db.connect(RUNTIME_ROLE),
      log,
      clients: {},
      topics: {},
      identity,
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([pool.end(), limiter.close()]);
    await db.drop();
  });

  /**
   * A top-level browser navigation, as the redirect from the app is. Over node:http, because fetch always sends
   * `sec-fetch-mode: cors`, which better-auth answers with JSON instead of a redirect.
   */
  const navigate = (path: string) =>
    new Promise<{ status: number; location: string | null }>((resolve, reject) => {
      httpGet(
        `${origin}${path}`,
        { headers: { accept: "text/html", "sec-fetch-mode": "navigate", [CLIENT_IP_HEADER]: ip } },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null }),
          );
        },
      ).on("error", reject);
    });
  const get = (path: string) => fetch(`${origin}${path}`, { headers: { [CLIENT_IP_HEADER]: ip } });
  /** Where an authorize request sends the browser, as a path on platform or an absolute URL elsewhere. */
  const authorizeTo = async (params: Record<string, string>) => {
    const { status, location } = await navigate(
      `/api/auth/oauth2/authorize?${new URLSearchParams(params)}`,
    );
    return { status, to: location === null ? null : new URL(location, origin) };
  };
  const postJson = (path: string, body: unknown, from = ip) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin, [CLIENT_IP_HEADER]: from },
      body: JSON.stringify(body),
    });
  const token = (form: Record<string, string>, secret = CLIENT_SECRET) =>
    fetch(`${origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${CLIENT}:${secret}`).toString("base64")}`,
        [CLIENT_IP_HEADER]: ip,
      },
      body: new URLSearchParams(form),
    });

  function authorizeQuery(overrides: Record<string, string> = {}) {
    const verifier = base64url(randomBytes(32));
    const params = {
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT_URI,
      scope: "openid email profile",
      state: base64url(randomBytes(16)),
      nonce: base64url(randomBytes(16)),
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      ...overrides,
    };
    return { verifier, params };
  }

  /** Authorize, then the sign-in page's two calls; returns the code the client's callback would receive. */
  async function signIn(email: string, overrides: Record<string, string> = {}) {
    const { verifier, params } = authorizeQuery(overrides);
    const { status, to: signInPage } = await authorizeTo(params);
    expect(status).toBe(302);
    expect(signInPage?.origin).toBe(origin);
    expect(signInPage?.pathname).toBe("/sign-in");
    if (!signInPage) throw new Error("no redirect to the sign-in page");

    const sent = await postJson("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    expect(sent.status).toBe(200);
    const otp = codes.get(email);
    expect(otp).toMatch(/^\d{6}$/);

    const signedIn = await postJson("/api/auth/sign-in/email-otp", {
      email,
      otp,
      oauth_query: signInPage.search.slice(1),
    });
    expect(signedIn.status).toBe(200);
    const { url } = (await signedIn.json()) as { url: string };
    const callback = new URL(url);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe(params.state);
    const code = callback.searchParams.get("code");
    if (!code) throw new Error(`no code in ${url}`);
    return { code, verifier, nonce: params.nonce };
  }

  const exchange = (code: string, verifier: string, secret?: string) =>
    token(
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      },
      secret,
    );

  it("signs a person in with an emailed code and issues an ID token the JWKS verifies", async () => {
    const email = `owner-${randomUUID()}@example.test`;
    const { code, verifier, nonce } = await signIn(email);

    const issued = await exchange(code, verifier);
    expect(issued.status).toBe(200);
    const { id_token } = (await issued.json()) as { id_token: string };

    const discovery = (await (await get("/.well-known/openid-configuration")).json()) as {
      issuer: string;
      jwks_uri: string;
    };
    expect(discovery.issuer).toBe(origin);
    const jwks = createLocalJWKSet(await (await fetch(discovery.jwks_uri)).json());
    const { payload } = await jwtVerify(id_token, jwks, { issuer: origin, audience: CLIENT });
    expect(payload.nonce).toBe(nonce);
    expect(payload.email).toBe(email);
    expect(payload.email_verified).toBe(true);
    expect(payload).toHaveProperty("name");
    expect(payload.sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("gives the same person the same subject on a second sign-in", async () => {
    const email = `again-${randomUUID()}@example.test`;
    const subject = async () => {
      const { code, verifier } = await signIn(email);
      const { id_token } = (await (await exchange(code, verifier)).json()) as { id_token: string };
      return JSON.parse(Buffer.from(id_token.split(".")[1] ?? "", "base64url").toString())
        .sub as string;
    };
    expect(await subject()).toBe(await subject());
  });

  it("refuses a code exchanged with the wrong PKCE verifier", async () => {
    const { code } = await signIn(`pkce-${randomUUID()}@example.test`);
    const refused = await exchange(code, base64url(randomBytes(32)));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses a code exchanged with the wrong client secret", async () => {
    const { code, verifier } = await signIn(`secret-${randomUUID()}@example.test`);
    const refused = await exchange(code, verifier, "wrong-secret-".padEnd(48, "z"));
    expect(refused.status).toBe(401);
  });

  it("refuses a code exchanged a second time", async () => {
    const { code, verifier } = await signIn(`replay-${randomUUID()}@example.test`);
    expect((await exchange(code, verifier)).status).toBe(200);
    const replayed = await exchange(code, verifier);
    expect(replayed.status).toBe(400);
  });

  it("starts sign-in for a valid request (the control for the refusals below)", async () => {
    const { to } = await authorizeTo(authorizeQuery().params);
    expect(to?.pathname).toBe("/sign-in");
  });

  it("never redirects to a redirect URI that is not registered", async () => {
    const { to } = await authorizeTo(
      authorizeQuery({ redirect_uri: "https://attacker.test/callback" }).params,
    );
    expect(to?.host).not.toBe("attacker.test");
    expect(to?.pathname).not.toBe("/sign-in");
  });

  it("refuses authorization without PKCE", async () => {
    const {
      code_challenge: _c,
      code_challenge_method: _m,
      ...withoutPkce
    } = authorizeQuery().params;
    const { to } = await authorizeTo(withoutPkce);
    expect(to?.pathname).not.toBe("/sign-in");
  });

  it("refuses a client that was dropped from config", async () => {
    const { to } = await authorizeTo(authorizeQuery({ client_id: "retired" }).params);
    expect(to?.pathname).not.toBe("/sign-in");
  });

  it("answers 404 for better-auth routes that are not listed", async () => {
    for (const path of [
      "/api/auth/token",
      "/api/auth/oauth2/register",
      "/api/auth/admin/oauth2/create-client",
    ]) {
      expect((await postJson(path, {})).status, path).toBe(404);
    }
    expect((await get("/api/auth/get-session")).status).toBe(404);
  });

  it("sends at most five codes an hour to one address", async () => {
    const email = `flood-${randomUUID()}@example.test`;
    const statuses: number[] = [];
    // A new IP for each request, so only the per-address limit can refuse.
    for (let i = 0; i < 6; i++) {
      const from = `10.${randomBytes(3).join(".")}`;
      const sent = await postJson(
        "/api/auth/email-otp/send-verification-otp",
        { email, type: "sign-in" },
        from,
      );
      statuses.push(sent.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("keeps the runtime role to row rights in the identity schema", async () => {
    const tryAs = (sql: string) =>
      pool.query(sql).then(
        () => "allowed",
        (error: Error) => error.message,
      );
    expect(await tryAs('truncate identity."user" cascade')).toMatch(/permission denied/);
    expect(await tryAs("create table identity.extra (id int)")).toMatch(/permission denied/);
  });

  it("ships the migration better-auth would generate for these options", async () => {
    const file = await readFile(
      new URL("../migrations/identity/0001_identity.sql", import.meta.url),
      "utf8",
    );
    expect(file).toBe(await identitySql());
  });
});
