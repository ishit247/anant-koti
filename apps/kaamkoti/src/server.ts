// The web process's shared objects, built on the first request: config is parsed once, the pool, the sign-in
// client, the object store and the rate limiter are made once. Kept on globalThis so Next's dev reloads do not
// leak a pool each time.
import { type Audit, createAudit } from "@bodhchakra/audit";
import { type Auth, createAuth } from "@bodhchakra/auth";
import { type BillingClient, createBillingClient } from "@bodhchakra/billing";
import { defineConfig } from "@bodhchakra/config";
import { createPool, type Db } from "@bodhchakra/db";
import { createJobs } from "@bodhchakra/jobs";
import { createLogger, type Logger } from "@bodhchakra/log";
import { createNotify } from "@bodhchakra/notify";
import { createOutbox } from "@bodhchakra/outbox";
import { createPayments, type Payments } from "@bodhchakra/payments";
import { type Limiter, redisLimiter } from "@bodhchakra/rate-limit";
import { createStorage, type Storage } from "@bodhchakra/storage";
import { PRIVATE_BUCKET, webConfig } from "./config.ts";
import { type Geocoder, nominatim } from "./geocode.ts";
import { createNotices, type Notices } from "./notices.ts";

export interface Server {
  readonly db: Db;
  /** Members' sign-in, on the app host. */
  readonly auth: Auth<"member">;
  /** Customers' sign-in, on the bare domain (D15). */
  readonly customerAuth: Auth<"customer">;
  readonly log: Logger;
  readonly storage: Storage;
  readonly limiter: Limiter;
  readonly audit: Audit;
  /** The address of a point a customer picked (D16). */
  readonly geocode: Geocoder;
  /** Messages to customers and owners, through the outbox; the worker delivers them to platform. */
  readonly notices: Notices;
  /** Each business's own Razorpay account: deposit links, and money known only from its webhook. */
  readonly payments: Payments;
  /** What the business pays us: its trial, its local subscription copy, platform's events and the checkout. */
  readonly billing: BillingClient;
  /** Where browsers reach this app: the base of every link sent to a customer. */
  readonly origin: string;
  /** The bare domain: public pages and the customer space. */
  readonly publicOrigin: string;
}

const holder = globalThis as { __kaamkotiServer?: Server };

export function server(): Server {
  holder.__kaamkotiServer ??= build();
  return holder.__kaamkotiServer;
}

function build(): Server {
  const config = defineConfig(webConfig);
  const log = createLogger({ service: "kaamkoti-web" });
  const db = createPool({ url: config.DATABASE_URL, log });
  const client = {
    db,
    log,
    issuer: config.IDENTITY_ORIGIN,
    internalUrl: config.PLATFORM_INTERNAL_URL,
    clientId: "kaamkoti",
    clientSecret: config.SIGN_IN_CLIENT_SECRET,
    cookiePrefix: "kk",
  };
  const auth = createAuth({
    ...client,
    kind: "member",
    redirectUri: `${config.APP_ORIGIN}/auth/callback`,
    postLogoutRedirectUri: `${config.APP_ORIGIN}/`,
  });
  // One client, a second redirect URI: a callback cannot name the business (redirect URIs are registered
  // exactly), so the slug travels in the return path and in the sign-out `state`.
  const customerAuth = createAuth({
    ...client,
    kind: "customer",
    redirectUri: `${config.PUBLIC_ORIGIN}/customer/callback`,
    postLogoutRedirectUri: `${config.PUBLIC_ORIGIN}/customer/signed-out`,
  });
  const storage = createStorage({
    endpoint: config.S3_ENDPOINT,
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    bucket: PRIVATE_BUCKET,
  });
  // The web only queues jobs; the worker runs them. Started in the background: the first send waits for it, and
  // if it failed, that send fails with its error.
  const jobs = createJobs({ url: config.DATABASE_URL, log, sendOnly: true });
  const outbox = createOutbox({ jobs, log });
  const notices = createNotices({
    notify: createNotify(outbox),
    jobs,
    appOrigin: config.APP_ORIGIN,
    publicOrigin: config.PUBLIC_ORIGIN,
  });
  jobs
    .start([...outbox.jobTypes, ...notices.jobTypes])
    .catch((error: unknown) => log.error("jobs start failed", { error }));
  const audit = createAudit(log);
  return {
    db,
    auth,
    customerAuth,
    log,
    storage,
    limiter: redisLimiter(config.REDIS_URL, log),
    audit,
    payments: createPayments({
      sealingKey: config.PAYMENTS_SEALING_KEY,
      audit,
      log,
      razorpayApi: config.RAZORPAY_API,
    }),
    billing: createBillingClient({
      db,
      log,
      outbox,
      platformUrl: config.PLATFORM_INTERNAL_URL,
      client: "kaamkoti",
      secret: config.SERVICE_SECRET,
    }),
    geocode: nominatim(config.GEOCODER_URL, log),
    notices,
    origin: config.APP_ORIGIN,
    publicOrigin: config.PUBLIC_ORIGIN,
  };
}
