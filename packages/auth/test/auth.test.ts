// The app side of sign-in against a stand-in platform that this test controls, so it can answer with forged,
// mismatched and expired ID tokens; real Postgres. The flow against the real platform is tested in
// apps/kaamkoti/test/sign-in.test.ts.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { createBusiness, migrations as tenancy } from "@bodhchakra/tenancy";
import { migrations as tokens } from "@bodhchakra/tokens";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT, UnsecuredJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Auth,
  createAuth,
  migrations,
  SignInRefused,
  SignInUnavailable,
  safeReturnTo,
} from "../src/index.ts";

const CLIENT = "kaamkoti";
const SECRET = "kaamkoti-auth-test-secret-".padEnd(48, "x");
const REDIRECT_URI = "https://app.kaamkoti.test/auth/callback";
const AFTER_SIGN_OUT = "https://app.kaamkoti.test/";
const ISSUER = "https://id.platform.test";
const KID = "platform-key";
const PRAKASH = "00000000-0000-4000-8000-00000000d001";
const NEWCOMER = "00000000-0000-4000-8000-00000000d099";

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;

describe("auth", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  let sharma: string;
  let server: Server;
  let internalUrl: string;
  let auth: Auth;
  let platformKeys: Keys;
  let otherKeys: Keys;
  /** What the stand-in token endpoint answers next, and the requests it saw. */
  let answer: () => { status: number; body: unknown };
  const tokenRequests: { authorization: string | undefined; form: URLSearchParams }[] = [];
  const log = createLogger({ service: "test", write: () => undefined });

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [tokens, tenancy, migrations],
    });
    app = database.connect("kaamkoti_app");
    owner = database.connect("kaamkoti_owner");
    sharma = (
      await createBusiness(
        app,
        {
          slug: "sharma-cooling",
          name: "Sharma Cooling Services",
          phone: "+919000000101",
          city: "Pune",
        },
        { identityId: PRAKASH, displayName: "Prakash Sharma" },
      )
    ).businessId;

    platformKeys = await generateKeyPair("EdDSA", { extractable: true });
    otherKeys = await generateKeyPair("EdDSA", { extractable: true });
    const jwks = {
      keys: [{ ...(await exportJWK(platformKeys.publicKey)), kid: KID, alg: "EdDSA" }],
    };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let reply: { status: number; body: unknown } = {
          status: 404,
          body: { error: "not_found" },
        };
        if (req.method === "GET" && req.url === "/api/auth/jwks")
          reply = { status: 200, body: jwks };
        if (req.method === "POST" && req.url === "/api/auth/oauth2/token") {
          tokenRequests.push({
            authorization: req.headers.authorization,
            form: new URLSearchParams(Buffer.concat(chunks).toString()),
          });
          reply = answer();
        }
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    internalUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    auth = createAuth({
      db: app,
      log,
      issuer: ISSUER,
      internalUrl,
      clientId: CLIENT,
      clientSecret: SECRET,
      redirectUri: REDIRECT_URI,
      postLogoutRedirectUri: AFTER_SIGN_OUT,
      cookiePrefix: "kk",
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.drop();
  });

  /** A browser that has been to /login: the callback query platform would send, and its login cookie. */
  async function begin(returnTo?: string) {
    const { location, setCookie } = await auth.startLogin(returnTo);
    const authorize = new URL(location);
    const state = authorize.searchParams.get("state") ?? "";
    return {
      authorize,
      state,
      nonce: authorize.searchParams.get("nonce") ?? "",
      cookie: setCookie.split(";")[0] ?? "",
      query: new URLSearchParams({ code: `code-${state}`, state }),
    };
  }

  /** An ID token as platform issues it, with `overrides` applied. */
  function idToken(nonce: string, overrides: JWTPayload = {}, keys = platformKeys) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: ISSUER,
      aud: CLIENT,
      iat: now,
      exp: now + 300,
      sub: PRAKASH,
      nonce,
      email: "prakash@example.com",
      email_verified: true,
      name: "Prakash Sharma",
      ...overrides,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: KID })
      .sign(keys.privateKey);
  }

  const issue = (token: string) => {
    answer = () => ({ status: 200, body: { id_token: token, token_type: "Bearer" } });
  };

  const sessionRows = async () =>
    Number(
      (await owner.tx((c) => c.query<{ n: string }>("select count(*) as n from auth.session")))
        .rows[0]?.n,
    );

  async function signIn(returnTo?: string) {
    const browser = await begin(returnTo);
    issue(await idToken(browser.nonce));
    const signedIn = await auth.handleCallback(browser.query, browser.cookie);
    const sessionCookie = signedIn.setCookies[0]?.split(";")[0] ?? "";
    return { browser, signedIn, sessionCookie };
  }

  it("signs a member in and links the session to their membership", async () => {
    const { browser, signedIn, sessionCookie } = await signIn("/jobs?day=today");

    expect(signedIn.session.identityId).toBe(PRAKASH);
    expect(signedIn.session.memberships.map((m) => [m.businessId, m.role])).toEqual([
      [sharma, "owner"],
    ]);
    expect(signedIn.identity).toEqual({ email: "prakash@example.com", name: "Prakash Sharma" });
    expect(signedIn.returnTo).toBe("/jobs?day=today");
    expect(signedIn.setCookies[0]).toMatch(
      /^__Host-kk_session=[\w-]{43}; Path=\/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax$/,
    );
    expect(signedIn.setCookies[1]).toMatch(/^__Host-kk_login=; Path=\/; Max-Age=0;/);

    const session = await auth.getSession(`other=1; ${sessionCookie}`);
    expect(session?.identityId).toBe(PRAKASH);
    expect(session?.memberships[0]?.memberId).toBe(signedIn.session.memberships[0]?.memberId);

    // The code went back with the PKCE verifier matching the challenge, and the client's credentials.
    const sent = tokenRequests.at(-1);
    const verifier = sent?.form.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      browser.authorize.searchParams.get("code_challenge"),
    );
    expect(sent?.form.get("code")).toBe(`code-${browser.state}`);
    expect(sent?.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`,
    );
  });

  it("sends the browser to platform's authorize with PKCE, state and nonce", async () => {
    const { authorize, cookie } = await begin();
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/api/auth/oauth2/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT_URI,
      scope: "openid email profile",
      code_challenge_method: "S256",
    });
    expect(cookie).toBe(`__Host-kk_login=${authorize.searchParams.get("state")}`);
  });

  it("signs in someone with no membership yet, with no memberships", async () => {
    const browser = await begin();
    issue(await idToken(browser.nonce, { sub: NEWCOMER }));
    const signedIn = await auth.handleCallback(browser.query, browser.cookie);
    expect(signedIn.session).toEqual({ identityId: NEWCOMER, memberships: [] });
  });

  it("stores only a hash of the session token", async () => {
    const { sessionCookie } = await signIn();
    const token = sessionCookie.split("=")[1] ?? "";
    const { rows } = await owner.tx((c) =>
      c.query<{ hashed: boolean; plain: boolean }>(
        `select exists (select 1 from auth.session where token_hash = $1) as hashed,
                exists (select 1 from auth.session s where s::text like '%' || $2 || '%') as plain`,
        [createHash("sha256").update(token).digest(), token],
      ),
    );
    expect(rows[0]).toEqual({ hashed: true, plain: false });
  });

  describe("refuses, with no session", () => {
    const refused = async (query: URLSearchParams, cookie: string | null) => {
      const before = await sessionRows();
      await expect(auth.handleCallback(query, cookie)).rejects.toBeInstanceOf(SignInRefused);
      expect(await sessionRows()).toBe(before);
    };

    it("a replayed sign-in response", async () => {
      const { browser } = await signIn();
      issue(await idToken(browser.nonce));
      await refused(browser.query, browser.cookie);
    });

    it("a response to an attempt started in another browser", async () => {
      const attacker = await begin();
      const victim = await begin();
      issue(await idToken(attacker.nonce));
      await refused(attacker.query, victim.cookie);
    });

    it("a response with no login cookie", async () => {
      const browser = await begin();
      issue(await idToken(browser.nonce));
      await refused(browser.query, null);
    });

    it("a state nobody started", async () => {
      const browser = await begin();
      issue(await idToken(browser.nonce));
      const forged = new URLSearchParams({ code: "x", state: "A".repeat(43) });
      await refused(forged, `__Host-kk_login=${"A".repeat(43)}`);
    });

    it("an attempt older than ten minutes", async () => {
      const browser = await begin();
      await owner.tx((c) =>
        c.query(
          "update auth.login_attempt set expires_at = now() - interval '1 second' where state = $1",
          [browser.state],
        ),
      );
      issue(await idToken(browser.nonce));
      await refused(browser.query, browser.cookie);
    });

    it("an error from platform", async () => {
      const browser = await begin();
      issue(await idToken(browser.nonce));
      await refused(
        new URLSearchParams({ error: "access_denied", state: browser.state }),
        browser.cookie,
      );
    });

    it("a code platform will not exchange", async () => {
      const browser = await begin();
      answer = () => ({ status: 400, body: { error: "invalid_grant" } });
      await refused(browser.query, browser.cookie);
    });

    const forgeries: [string, (nonce: string) => Promise<string>][] = [
      ["signed by a key that is not platform's", (nonce) => idToken(nonce, {}, otherKeys)],
      ["for another sign-in (wrong nonce)", () => idToken("some-other-nonce")],
      ["for another client", (nonce) => idToken(nonce, { aud: "pos" })],
      ["from another issuer", (nonce) => idToken(nonce, { iss: "https://id.attacker.test" })],
      ["that has expired", (nonce) => idToken(nonce, { exp: Math.floor(Date.now() / 1000) - 120 })],
      [
        "issued too long ago",
        (nonce) => idToken(nonce, { iat: Math.floor(Date.now() / 1000) - 600 }),
      ],
      ["with an unverified email", (nonce) => idToken(nonce, { email_verified: false })],
      ["with a subject that is not an identity id", (nonce) => idToken(nonce, { sub: "admin" })],
      [
        "unsigned",
        async (nonce) =>
          new UnsecuredJWT({
            sub: PRAKASH,
            nonce,
            email: "p@example.com",
            email_verified: true,
            name: "P",
          })
            .setIssuer(ISSUER)
            .setAudience(CLIENT)
            .setIssuedAt()
            .setExpirationTime("5m")
            .encode(),
      ],
      [
        "signed with HMAC",
        (nonce) =>
          new SignJWT({
            sub: PRAKASH,
            nonce,
            email: "p@example.com",
            email_verified: true,
            name: "P",
          })
            .setProtectedHeader({ alg: "HS256", kid: KID })
            .setIssuer(ISSUER)
            .setAudience(CLIENT)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(new TextEncoder().encode(SECRET)),
      ],
    ];
    it.each(forgeries)("an ID token %s", async (_name, forge) => {
      const browser = await begin();
      issue(await forge(browser.nonce));
      await refused(browser.query, browser.cookie);
    });
  });

  it("reports platform being unreachable as unavailable, not refused", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const offline = createAuth({
      db: app,
      log,
      issuer: ISSUER,
      internalUrl: `http://127.0.0.1:${port}`,
      clientId: CLIENT,
      clientSecret: SECRET,
      redirectUri: REDIRECT_URI,
      postLogoutRedirectUri: AFTER_SIGN_OUT,
      cookiePrefix: "kk",
    });
    const { location, setCookie } = await offline.startLogin();
    const state = new URL(location).searchParams.get("state") ?? "";
    await expect(
      offline.handleCallback(
        new URLSearchParams({ code: "x", state }),
        setCookie.split(";")[0] ?? "",
      ),
    ).rejects.toBeInstanceOf(SignInUnavailable);
  });

  describe("sessions", () => {
    const hashOf = (cookie: string) =>
      createHash("sha256")
        .update(cookie.split("=")[1] ?? "")
        .digest();
    const age = (cookie: string, column: "expires_at" | "last_seen_at", ago: string) =>
      owner.tx((c) =>
        c.query(`update auth.session set ${column} = now() - $2::interval where token_hash = $1`, [
          hashOf(cookie),
          ago,
        ]),
      );

    it("are not found without a cookie, or with one that names no session", async () => {
      expect(await auth.getSession(null)).toBeNull();
      expect(await auth.getSession("__Host-kk_session=not-a-token")).toBeNull();
      expect(await auth.getSession(`__Host-kk_session=${"B".repeat(43)}`)).toBeNull();
    });

    it("end after seven idle days", async () => {
      const { sessionCookie } = await signIn();
      await age(sessionCookie, "last_seen_at", "7 days 1 minute");
      expect(await auth.getSession(sessionCookie)).toBeNull();
    });

    it("restart the idle clock on a visit", async () => {
      const { sessionCookie } = await signIn();
      await age(sessionCookie, "last_seen_at", "6 days");
      expect(await auth.getSession(sessionCookie)).not.toBeNull();
      const { rows } = await owner.tx((c) =>
        c.query<{ recent: boolean }>(
          "select last_seen_at > now() - interval '1 minute' as recent from auth.session where token_hash = $1",
          [hashOf(sessionCookie)],
        ),
      );
      expect(rows[0]?.recent).toBe(true);
    });

    it("end thirty days after sign-in however active", async () => {
      const { sessionCookie } = await signIn();
      await age(sessionCookie, "expires_at", "1 second");
      expect(await auth.getSession(sessionCookie)).toBeNull();
    });

    it("end on sign-out, which sends the browser to platform's end-session with the ID token", async () => {
      const { sessionCookie } = await signIn();
      const out = await auth.signOut(sessionCookie);
      expect(out.setCookie).toMatch(/^__Host-kk_session=; Path=\/; Max-Age=0;/);
      const location = new URL(out.location);
      expect(location.origin + location.pathname).toBe(`${ISSUER}/api/auth/oauth2/end-session`);
      expect(location.searchParams.get("client_id")).toBe(CLIENT);
      expect(location.searchParams.get("post_logout_redirect_uri")).toBe(AFTER_SIGN_OUT);
      expect(location.searchParams.get("id_token_hint")?.split(".")).toHaveLength(3);
      expect(await auth.getSession(sessionCookie)).toBeNull();
      // Signing out again, or with no session, just comes home.
      expect((await auth.signOut(sessionCookie)).location).toBe(AFTER_SIGN_OUT);
      expect((await auth.signOut(null)).location).toBe(AFTER_SIGN_OUT);
    });
  });

  it("returns only to paths on this app", () => {
    expect(safeReturnTo("/jobs/1?tab=photos#top")).toBe("/jobs/1?tab=photos#top");
    for (const path of [
      null,
      "",
      "jobs",
      "//evil.example/x",
      "/\\evil.example",
      "/\t/evil.example",
      "https://evil.example/",
      `/${"a".repeat(2048)}`,
    ]) {
      expect(safeReturnTo(path), String(path)).toBe("/");
    }
  });

  it("keeps a login attempt unchangeable for the runtime role", async () => {
    const error = await app
      .tx((c) => c.query("update auth.login_attempt set return_to = '/x'"))
      .catch((e: Error) => e.message);
    expect(error).toMatch(/permission denied/);
  });
});
