// One identity signs in to Kaam Koti through the real platform, in process, over HTTP, against real Postgres
// and Redis (docs/architecture.md 3). The test plays the browser; forged responses are tested in packages/auth.
import { randomBytes } from "node:crypto";
import { get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Auth, createAuth, SignInRefused } from "@bodhchakra/auth";
import { type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { type Limiter, redisLimiter } from "@bodhchakra/rate-limit";
import pg from "pg";
import * as platform from "platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations, RUNTIME_ROLE, seed } from "../src/index.ts";

const CLIENT = "kaamkoti";
const CLIENT_SECRET = "kaamkoti-sign-in-test-secret-".padEnd(48, "x");
const REDIRECT_URI = "https://app.kaamkoti.test/auth/callback";
const HOME = "https://app.kaamkoti.test/";
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:45444";
/** Seeded on both sides: platform's identity and Kaam Koti's member share the id. */
const PRAKASH = { id: "00000000-0000-4000-8000-00000000d001", email: "prakash@example.com" };
const SHARMA = "10000000-0000-4000-8000-000000000001";

describe("signing in to Kaam Koti through platform", () => {
  let kaamkoti: TestDb;
  let platformDb: TestDb;
  let identityPool: pg.Pool;
  let limiter: Limiter;
  let server: Server;
  let origin: string;
  let auth: Auth;
  const codes = new Map<string, string>();
  /** One per run, so earlier runs' counters in Redis do not count against this one. */
  const ip = `10.${randomBytes(3).join(".")}`;
  const log = createLogger({ service: "test", write: () => undefined });
  /** The browser's cookies on platform's host. */
  const platformCookies = new Map<string, string>();

  beforeAll(async () => {
    [kaamkoti, platformDb] = await Promise.all([
      testDb({ owner: "kaamkoti_owner", runtimeRole: RUNTIME_ROLE, folders: migrations }),
      testDb({
        owner: "platform_owner",
        runtimeRole: platform.RUNTIME_ROLE,
        folders: platform.migrations,
      }),
    ]);
    await Promise.all([
      seed(kaamkoti.url("kaamkoti_owner"), log),
      platform.seed(platformDb.url("platform_owner"), log),
    ]);

    identityPool = new pg.Pool({ connectionString: platformDb.url(platform.RUNTIME_ROLE), max: 3 });
    limiter = redisLimiter(REDIS_URL, log);
    await platform.registerClients(identityPool, {
      [CLIENT]: {
        secret: CLIENT_SECRET,
        redirectUris: [REDIRECT_URI],
        postLogoutRedirectUris: [HOME],
      },
    });
    let handler: (request: Request) => Promise<Response> = () =>
      Promise.reject(new Error("not ready"));
    server = await platform.listen((request) => handler(request), log, 0, "127.0.0.1");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    handler = platform.createHandler({
      db: platformDb.connect(platform.RUNTIME_ROLE),
      log,
      clients: {},
      topics: {},
      identity: platform.createIdentity(
        {
          pool: identityPool,
          origin,
          secret: "identity-test-secret-".padEnd(48, "y"),
          limit: limiter.limit,
          sendCode: async (to, code) => {
            codes.set(to.email, code);
          },
        },
        log,
      ),
    });

    auth = createAuth({
      kind: "member",
      db: kaamkoti.connect(RUNTIME_ROLE),
      log,
      issuer: origin,
      internalUrl: origin,
      clientId: CLIENT,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      postLogoutRedirectUri: HOME,
      cookiePrefix: "kk",
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([identityPool.end(), limiter.close()]);
    await Promise.all([kaamkoti.drop(), platformDb.drop()]);
  });

  const cookieHeader = () => [...platformCookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const keepCookies = (setCookies: string[]) => {
    for (const line of setCookies) {
      const [pair = ""] = line.split(";");
      const eq = pair.indexOf("=");
      const value = pair.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(line)) platformCookies.delete(pair.slice(0, eq));
      else platformCookies.set(pair.slice(0, eq), value);
    }
  };

  /** A top-level navigation to platform, as the browser makes it (node:http: fetch sends sec-fetch-mode cors). */
  const navigate = (url: string) =>
    new Promise<URL>((resolve, reject) => {
      httpGet(
        url,
        {
          headers: {
            accept: "text/html",
            "sec-fetch-mode": "navigate",
            cookie: cookieHeader(),
            [platform.CLIENT_IP_HEADER]: ip,
          },
        },
        (res) => {
          res.resume();
          const setCookie = res.headers["set-cookie"];
          if (setCookie) keepCookies(setCookie);
          res.on("end", () => {
            if (!res.headers.location)
              reject(new Error(`no redirect from ${url}: ${res.statusCode}`));
            else resolve(new URL(res.headers.location, origin));
          });
        },
      ).on("error", reject);
    });

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${origin}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: cookieHeader(),
        [platform.CLIENT_IP_HEADER]: ip,
      },
      body: JSON.stringify(body),
    });
    keepCookies(response.headers.getSetCookie());
    expect(response.status, path).toBe(200);
    return response.json() as Promise<{ url?: string }>;
  };

  it("signs a seeded owner in, opens their business, and signs them out of both", async () => {
    // GET /login on Kaam Koti.
    const login = await auth.startLogin("/jobs");
    const loginCookie = login.setCookie.split(";")[0] ?? "";

    // Platform asks who it is, by a code to their address.
    const signInPage = await navigate(login.location);
    expect(signInPage.origin + signInPage.pathname).toBe(`${origin}/sign-in`);
    await post("/email-otp/send-verification-otp", { email: PRAKASH.email, type: "sign-in" });
    const { url } = await post("/sign-in/email-otp", {
      email: PRAKASH.email,
      otp: codes.get(PRAKASH.email),
      oauth_query: signInPage.search.slice(1),
    });
    const callback = new URL(url ?? "");
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);

    // GET /auth/callback on Kaam Koti.
    const signedIn = await auth.handleCallback(callback.searchParams, loginCookie);
    expect(signedIn.session.identityId).toBe(PRAKASH.id);
    expect(signedIn.session.memberships).toMatchObject([
      { businessId: SHARMA, role: "owner", displayName: "Prakash Sharma" },
    ]);
    expect(signedIn.identity.email).toBe(PRAKASH.email);
    expect(signedIn.returnTo).toBe("/jobs");

    // The same response again is refused.
    await expect(auth.handleCallback(callback.searchParams, loginCookie)).rejects.toBeInstanceOf(
      SignInRefused,
    );

    const sessionCookie = signedIn.setCookies[0]?.split(";")[0] ?? "";
    expect((await auth.getSession(sessionCookie))?.identityId).toBe(PRAKASH.id);

    // While platform's session lives, a new sign-in goes straight back to Kaam Koti (the control).
    const again = await navigate((await auth.startLogin()).location);
    expect(again.origin + again.pathname).toBe(REDIRECT_URI);

    // Sign-out ends the Kaam Koti session, then platform's, and comes home.
    const out = await auth.signOut(sessionCookie);
    expect(await auth.getSession(sessionCookie)).toBeNull();
    expect((await navigate(out.location)).href).toBe(HOME);

    // Platform asks again: the next person on this device does not walk in.
    const afterSignOut = await navigate((await auth.startLogin()).location);
    expect(afterSignOut.origin + afterSignOut.pathname).toBe(`${origin}/sign-in`);
  });
});
