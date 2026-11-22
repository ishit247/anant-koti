// Against a stub of Nominatim on a local port: tests never send a point to the real service.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "@bodhchakra/log";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { nominatim, point } from "../src/index.ts";

type Reply = { status: number; body: string } | "hang";

describe("reverse geocoding a picked location (D16)", () => {
  let stub: Server;
  let base: string;
  let reply: Reply;
  let asked: URL | null;
  let userAgent: string | undefined;

  beforeAll(async () => {
    stub = createServer((request, response) => {
      asked = new URL(request.url ?? "/", "http://stub");
      userAgent = request.headers["user-agent"];
      if (reply === "hang") return;
      response.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
    });
    await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    asked = null;
  });
  afterAll(() => {
    stub.closeAllConnections();
    stub.close();
  });

  const geocode = () => nominatim(base, createLogger({ service: "test" }));
  const at = { latitude: 18.5074, longitude: 73.8077 };

  it("asks for the point, naming the app, and returns the address without the country", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        display_name: "Shanti Apartments, Kothrud, Pune, Maharashtra, 411038, India",
      }),
    };
    expect(await geocode()(at)).toBe("Shanti Apartments, Kothrud, Pune, Maharashtra, 411038");
    expect(asked?.pathname).toBe("/reverse");
    expect(asked?.searchParams.get("lat")).toBe("18.5074");
    expect(asked?.searchParams.get("lon")).toBe("73.8077");
    expect(userAgent).toBe("KaamKoti/1.0");
  });

  it("returns null where there is no address (open sea)", async () => {
    reply = { status: 200, body: JSON.stringify({ error: "Unable to geocode" }) };
    expect(await geocode()(at)).toBeNull();
  });

  it("returns null when the service answers with an error status", async () => {
    reply = { status: 503, body: "{}" };
    expect(await geocode()(at)).toBeNull();
  });

  it("returns null for an answer in a shape it does not know", async () => {
    reply = { status: 200, body: JSON.stringify({ display_name: 42 }) };
    expect(await geocode()(at)).toBeNull();
  });

  it("gives up on a service that does not answer", async () => {
    reply = "hang";
    expect(await geocode()(at)).toBeNull();
  }, 10_000);

  it("refuses a point off the globe before anything is asked", () => {
    expect(point.safeParse({ latitude: 91, longitude: 0 }).success).toBe(false);
    expect(point.safeParse({ latitude: "18.5", longitude: 73.8 }).success).toBe(false);
  });
});
