// Sign-in through platform's OpenID Connect provider, over real HTTP, against real Postgres and Redis
// (docs/architecture.md 3). The app side of the flow is played by this test; 0.6b builds it for real.
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { type Limiter, redisLimiter } from "@bodhchakra/rate-limit";
import { createLocalJWKSet, jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLIENT_IP_HEADER,
  createIdentity,
  type IdentityDeps,
  PHONE_CODE_PATH,
  registerClients,
} from "../src/identity.ts";
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
  /** Codes sent, by address (email or mobile). */
  const codes = new Map<string, string>();
  let identityDeps: IdentityDeps;
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
    identityDeps = {
      pool,
      origin,
      secret: "identity-test-secret-".padEnd(48, "y"),
      limit: limiter.limit,
      sendCode: async (to, code) => {
        codes.set(to.email, code);
      },
      sendPhoneCode: async (phone, code) => {
        codes.set(phone, code);
      },
    };
    const identity = createIdentity(identityDeps, log);
    handler = createHandler({
      db: db.connect(RUNTIME_ROLE),
      log,
      clients: {},
      topics: {},
      hooks: {},
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
      scope: "openid email profile phone",
      state: base64url(randomBytes(16)),
      nonce: base64url(randomBytes(16)),
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      ...overrides,
    };
    return { verifier, params };
  }

  /** The authorize redirect to the sign-in page; returns its signed query and what the client keeps. */
  async function startSignIn(overrides: Record<string, string> = {}) {
    const { verifier, params } = authorizeQuery(overrides);
    const { status, to: signInPage } = await authorizeTo(params);
    expect(status).toBe(302);
    expect(signInPage?.origin).toBe(origin);
    expect(signInPage?.pathname).toBe("/sign-in");
    if (!signInPage) throw new Error("no redirect to the sign-in page");
    return { verifier, params, oauthQuery: signInPage.search.slice(1) };
  }

  /** A mobile no earlier test or run has used. */
  const newMobile = () => `+91${randomInt(6, 10)}${String(randomInt(0, 1e9)).padStart(9, "0")}`;
  const sendPhoneCode = (phone: string, from = ip) => postJson(PHONE_CODE_PATH, { phone }, from);
  const verifyPhone = (body: Record<string, unknown>) =>
    postJson("/api/auth/phone-number/verify", body);

  /** As signIn, by a code sent to a mobile. */
  async function signInByPhone(phone: string) {
    const { verifier, params, oauthQuery } = await startSignIn();
    expect((await sendPhoneCode(phone)).status).toBe(200);
    const signedIn = await verifyPhone({
      phoneNumber: phone,
      code: codes.get(phone),
      oauth_query: oauthQuery,
    });
    expect(signedIn.status).toBe(200);
    return finishSignIn(signedIn, verifier, params);
  }

  /** The callback URL the sign-in answered with: the code the client's callback would receive. */
  async function finishSignIn(
    signedIn: Response,
    verifier: string,
    params: { state: string; nonce: string },
  ) {
    const { url } = (await signedIn.json()) as { url: string };
    const callback = new URL(url);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe(params.state);
    const code = callback.searchParams.get("code");
    if (!code) throw new Error(`no code in ${url}`);
    return { code, verifier, nonce: params.nonce };
  }

  /** The verified claims of the ID token a sign-in's code is exchanged for. */
  async function idTokenClaims(code: string, verifier: string) {
    const issued = await exchange(code, verifier);
    expect(issued.status).toBe(200);
    const { id_token } = (await issued.json()) as { id_token: string };
    const jwks = createLocalJWKSet(await (await get("/api/auth/jwks")).json());
    return (await jwtVerify(id_token, jwks, { issuer: origin, audience: CLIENT })).payload;
  }

  /** Authorize, then the sign-in page's two calls; returns the code the client's callback would receive. */
  async function signIn(email: string, overrides: Record<string, string> = {}) {
    const { verifier, params, oauthQuery } = await startSignIn(overrides);

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
      oauth_query: oauthQuery,
    });
    expect(signedIn.status).toBe(200);
    return finishSignIn(signedIn, verifier, params);
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

  describe("by mobile", () => {
    const subjectOf = async (phone: string) => {
      const { code, verifier } = await signInByPhone(phone);
      return (await idTokenClaims(code, verifier)).sub;
    };

    it("signs a person in with a WhatsApp code; the ID token carries the verified mobile and no email", async () => {
      const phone = newMobile();
      const { code, verifier, nonce } = await signInByPhone(phone);
      const claims = await idTokenClaims(code, verifier);
      expect(claims.nonce).toBe(nonce);
      expect(claims.phone_number).toBe(phone);
      expect(claims.phone_number_verified).toBe(true);
      // The identity's placeholder email is never given out as an address.
      expect(claims).not.toHaveProperty("email");
      expect(claims).not.toHaveProperty("email_verified");
    });

    it("gives the same mobile the same subject on a second sign-in", async () => {
      const phone = newMobile();
      expect(await subjectOf(phone)).toBe(await subjectOf(phone));
    });

    it("stores the code only as a keyed hash", async () => {
      const phone = newMobile();
      expect((await sendPhoneCode(phone)).status).toBe(200);
      const code = codes.get(phone) ?? "";
      const { rows } = await pool.query<{ code_hash: string }>(
        "select code_hash from identity.phone_code where phone = $1",
        [phone],
      );
      const stored = rows[0]?.code_hash ?? "";
      expect(stored).not.toContain(code);
      expect(stored).not.toBe(createHash("sha256").update(code).digest("hex"));
      expect(stored).not.toBe(createHash("sha256").update(`${phone}:${code}`).digest("hex"));
    });

    it("accepts a code once", async () => {
      const phone = newMobile();
      const { oauthQuery } = await startSignIn();
      await sendPhoneCode(phone);
      const body = { phoneNumber: phone, code: codes.get(phone), oauth_query: oauthQuery };
      expect((await verifyPhone(body)).status).toBe(200);
      expect((await verifyPhone(body)).status).toBe(400);
    });

    it("refuses the right code after five wrong ones", async () => {
      const phone = newMobile();
      const { oauthQuery } = await startSignIn();
      await sendPhoneCode(phone);
      const right = codes.get(phone) ?? "";
      const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
      for (let i = 0; i < 5; i++)
        expect((await verifyPhone({ phoneNumber: phone, code: wrong })).status).toBe(400);
      const late = await verifyPhone({ phoneNumber: phone, code: right, oauth_query: oauthQuery });
      expect(late.status).toBe(400);
    });

    it("accepts the right code after four wrong ones (the control for the limit)", async () => {
      const phone = newMobile();
      const { oauthQuery } = await startSignIn();
      await sendPhoneCode(phone);
      const right = codes.get(phone) ?? "";
      const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
      for (let i = 0; i < 4; i++) await verifyPhone({ phoneNumber: phone, code: wrong });
      const fifth = await verifyPhone({ phoneNumber: phone, code: right, oauth_query: oauthQuery });
      expect(fifth.status).toBe(200);
    });

    it("refuses a code checked for another mobile", async () => {
      const phone = newMobile();
      await sendPhoneCode(phone);
      const other = await verifyPhone({ phoneNumber: newMobile(), code: codes.get(phone) });
      expect(other.status).toBe(400);
    });

    it("sends at most five codes an hour to one mobile", async () => {
      const phone = newMobile();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++)
        statuses.push((await sendPhoneCode(phone, `10.${randomBytes(3).join(".")}`)).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    });

    it("refuses a number that is not an Indian mobile, and a request from another site", async () => {
      expect((await sendPhoneCode("+915123456789")).status).toBe(400);
      const crossSite = await fetch(`${origin}${PHONE_CODE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.test",
          [CLIENT_IP_HEADER]: ip,
        },
        body: JSON.stringify({ phone: newMobile() }),
      });
      expect(crossSite.status).toBe(403);
    });

    it("answers 503 while the WhatsApp channel is off", async () => {
      const { sendPhoneCode: _, ...withoutWhatsApp } = identityDeps;
      const off = createIdentity(withoutWhatsApp, log);
      const answer = await off.handle(
        new Request(`${origin}${PHONE_CODE_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ phone: newMobile() }),
        }),
        new URL(`${origin}${PHONE_CODE_PATH}`),
      );
      expect(answer?.status).toBe(503);
    });

    it("tells the sign-in page whether a code can go to a mobile", async () => {
      const page = (identity: ReturnType<typeof createIdentity>) =>
        identity
          .handle(new Request(`${origin}/sign-in`), new URL(`${origin}/sign-in`))
          ?.then((response) => response.text());
      const { sendPhoneCode: _, ...withoutWhatsApp } = identityDeps;
      expect(await page(createIdentity(identityDeps, log))).toContain('data-mobile="on"');
      expect(await page(createIdentity(withoutWhatsApp, log))).toContain('data-mobile="off"');
    });

    it("never attaches a mobile to a signed-in identity, only signs in with it", async () => {
      // A platform session, from an emailed code.
      const email = `attach-${randomUUID()}@example.test`;
      await postJson("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
      const signedIn = await postJson("/api/auth/sign-in/email-otp", {
        email,
        otp: codes.get(email),
      });
      const session = signedIn.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");
      expect(session).toContain("session_token=");

      const phone = newMobile();
      await sendPhoneCode(phone);
      const attach = await fetch(`${origin}/api/auth/phone-number/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: session,
          [CLIENT_IP_HEADER]: ip,
        },
        body: JSON.stringify({
          phoneNumber: phone,
          code: codes.get(phone),
          updatePhoneNumber: true,
        }),
      });
      expect(attach.status).toBe(400);
      const { rows } = await pool.query('select 1 from identity."user" where "phoneNumber" = $1', [
        phone,
      ]);
      expect(rows).toEqual([]);
    });

    it("never sends an emailed code to a phone identity's placeholder address", async () => {
      const phone = newMobile();
      await subjectOf(phone);
      const placeholder = `${phone.slice(1)}@phone.invalid`;
      const sent = await postJson("/api/auth/email-otp/send-verification-otp", {
        email: placeholder,
        type: "sign-in",
      });
      expect(sent.status).toBe(400);
      expect(codes.has(placeholder)).toBe(false);
    });
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
