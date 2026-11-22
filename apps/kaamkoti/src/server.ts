// The web process's shared objects, built on the first request: config is parsed once, the pool, the sign-in
// client, the object store and the rate limiter are made once. Kept on globalThis so Next's dev reloads do not
// leak a pool each time.
import { type Auth, createAuth } from "@bodhchakra/auth";
import { defineConfig } from "@bodhchakra/config";
import { createPool, type Db } from "@bodhchakra/db";
import { createLogger, type Logger } from "@bodhchakra/log";
import { type Limiter, redisLimiter } from "@bodhchakra/rate-limit";
import { createStorage, type Storage } from "@bodhchakra/storage";
import { PRIVATE_BUCKET, webConfig } from "./config.ts";

export interface Server {
  readonly db: Db;
  readonly auth: Auth;
  readonly log: Logger;
  readonly storage: Storage;
  readonly limiter: Limiter;
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
  const auth = createAuth({
    db,
    log,
    issuer: config.IDENTITY_ORIGIN,
    internalUrl: config.PLATFORM_INTERNAL_URL,
    clientId: "kaamkoti",
    clientSecret: config.SIGN_IN_CLIENT_SECRET,
    redirectUri: `${config.APP_ORIGIN}/auth/callback`,
    postLogoutRedirectUri: `${config.APP_ORIGIN}/`,
    cookiePrefix: "kk",
  });
  const storage = createStorage({
    endpoint: config.S3_ENDPOINT,
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    bucket: PRIVATE_BUCKET,
  });
  return { db, auth, log, storage, limiter: redisLimiter(config.REDIS_URL, log) };
}
