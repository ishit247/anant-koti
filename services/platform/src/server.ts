// Platform's HTTP surface. The handler speaks Web-standard Request and Response, so it can be mounted elsewhere
// later. `listen` puts it on node:http. Routes now: the health check, the internal API apps call with signed
// requests (docs/architecture.md 1 and 9.1), and identity's sign-in routes (3). Provider webhooks (3.3) join here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Db, DbClient } from "@bodhchakra/db";
import type { Logger } from "@bodhchakra/log";
import { delivery, receive } from "@bodhchakra/outbox";
import { CLIENT_HEADER, verifyRequest } from "@bodhchakra/tokens";
import type { z } from "zod";
import type { Identity } from "./identity.ts";

/** Larger bodies are refused before they are read in full. Messages carry ids and short variables. */
export const MAX_BODY_BYTES = 64 * 1024;
const INTERNAL = /^\/internal\/v1\/([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)$/;

/** One message type apps send to platform. It is handled in the transaction that records it in the inbox. */
export interface Topic<P> {
  readonly payload: z.ZodType<P>;
  handle(client: DbClient, payload: P, source: string): Promise<void>;
}

export interface PlatformDeps {
  /** Connects as platform_app. */
  db: Db;
  log: Logger;
  /** Client id to shared secret. */
  clients: Readonly<Record<string, string>>;
  // biome-ignore lint/suspicious/noExplicitAny: each topic's payload type is checked by its own schema.
  topics: Readonly<Record<string, Topic<any>>>;
  identity: Identity;
}

const json = (status: number, body: Record<string, string>) => Response.json(body, { status });

export function createHandler(deps: PlatformDeps): (request: Request) => Promise<Response> {
  const secretFor = (client: string) =>
    Object.hasOwn(deps.clients, client) ? deps.clients[client] : undefined;

  async function internal(request: Request, url: URL, topicName: string): Promise<Response> {
    const body = await request.text();
    const verified = verifyRequest({
      method: request.method,
      path: url.pathname + url.search,
      headers: request.headers,
      body,
      secretFor,
    });
    if (!verified.ok) {
      deps.log.warn("internal call refused", {
        reason: verified.reason,
        client: request.headers.get(CLIENT_HEADER)?.slice(0, 40),
        topic: topicName,
      });
      return json(401, { error: "unauthorized" });
    }
    const topic = Object.hasOwn(deps.topics, topicName) ? deps.topics[topicName] : undefined;
    if (!topic) return json(404, { error: "unknown_topic" });

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      return json(400, { error: "invalid_body" });
    }
    const message = delivery.safeParse(parsedBody);
    const payload = message.success ? topic.payload.safeParse(message.data.payload) : undefined;
    if (!message.success || !payload?.success) return json(400, { error: "invalid_body" });

    const handled = await deps.db.tx((client) =>
      receive(client, verified.client, message.data.key, () =>
        topic.handle(client, payload.data, verified.client),
      ),
    );
    return json(200, { status: handled ? "handled" : "duplicate" });
  }

  return async (request) => {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        await deps.db.tx((client) => client.query("select 1"));
        return json(200, { status: "ok" });
      }
      const internalPath = INTERNAL.exec(url.pathname);
      if (internalPath?.[1] && request.method === "POST")
        return await internal(request, url, internalPath[1]);
      const signIn = deps.identity.handle(request, url);
      if (signIn) return await signIn;
      return json(404, { error: "not_found" });
    } catch (error) {
      deps.log.error("request failed", { path: url.pathname, error });
      return json(url.pathname === "/health" ? 503 : 500, { error: "internal" });
    }
  };
}

/** Serves `handler` on node:http. Resolves once listening; `port` 0 picks a free one. */
export function listen(
  handler: (request: Request) => Promise<Response>,
  log: Logger,
  port: number,
  host = "0.0.0.0",
): Promise<Server> {
  const server = createServer((req, res) => {
    serve(req, res).catch((error: unknown) => {
      // The handler answers its own failures, so this is the adapter failing (e.g. an unparseable request line).
      log.error("http adapter failed", { error });
      if (res.headersSent) res.destroy();
      else
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad_request"}');
    });
  });
  async function serve(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" }).end('{"error":"too_large"}');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      headers.append(req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string);
    }
    const method = req.method ?? "GET";
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const response = await handler(request);
    // Object.fromEntries would keep one Set-Cookie of several; sign-in sets more than one.
    const outgoing: Record<string, string | string[]> = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outgoing["set-cookie"] = cookies;
    res.writeHead(response.status, outgoing);
    res.end(Buffer.from(await response.arrayBuffer()));
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
