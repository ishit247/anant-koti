// Against the development Garage and Postgres (infra/compose.dev.yml), with the app's web key, which
// `pnpm run up` imports with read and write on kaamkoti-private only.
import { createHash } from "node:crypto";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkImage, createStorage, migrations, StorageError } from "../src/index.ts";

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:45447";
const BUCKET = "kaamkoti-private";
/** DEV values from apps/kaamkoti/.env.development, public in the repository. */
const CONFIG = {
  endpoint: ENDPOINT,
  publicEndpoint: ENDPOINT,
  region: "garage",
  accessKeyId: "GK6b61616d6b6f74692d776562",
  secretAccessKey: "6b61616d6b6f74692d7765622d6465762d6f6e6c792d6e6f742d736563726574",
  bucket: BUCKET,
};
const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";

async function photo(background = "#b4411c") {
  const bytes = await sharp({ create: { width: 30, height: 20, channels: 3, background } })
    .jpeg()
    .toBuffer();
  const checked = await checkImage(bytes);
  if (!checked.ok) throw new Error("fixture refused");
  return checked.image;
}

describe("storage", () => {
  const storage = createStorage(CONFIG);
  let database: TestDb;
  let app: Db;
  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [migrations],
    });
    app = database.connect("kaamkoti_app");
  });
  afterAll(() => database.drop());

  const put = (businessId = A) =>
    photo().then((image) =>
      app.withTenant(businessId, async (client) => ({
        image,
        object: await storage.putImage(client, image, null),
      })),
    );

  it("records the object for the business and serves it by a signed URL", async () => {
    const { image, object } = await put();
    expect(object.key).toMatch(/^[0-9a-f-]{36}\.jpeg$/);
    const rows = await app.withTenant(A, (client) =>
      client.query(
        "select business_id, bucket, key, content_type, bytes, sha256 from storage.object",
      ),
    );
    expect(rows.rows).toContainEqual({
      business_id: A,
      bucket: BUCKET,
      key: object.key,
      content_type: "image/jpeg",
      bytes: image.bytes.byteLength,
      sha256: createHash("sha256").update(image.bytes).digest(),
    });
    const response = await fetch(storage.signedUrl(object));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer()).equals(image.bytes)).toBe(true);
  });

  it("refuses to serve an object without a signature", async () => {
    const { object } = await put();
    const response = await fetch(`${ENDPOINT}/${BUCKET}/${object.key}`);
    expect(response.status).toBe(403);
  });

  it("refuses to list the bucket to anyone without a key", async () => {
    await put();
    for (const query of ["", "?list-type=2"]) {
      const response = await fetch(`${ENDPOINT}/${BUCKET}${query}`);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toMatch(/<Key>/);
    }
  });

  it("signs a URL for one object only: the same signature does not open another", async () => {
    const one = await put();
    const two = await put();
    const url = new URL(storage.signedUrl(one.object));
    url.pathname = `/${BUCKET}/${two.object.key}`;
    expect((await fetch(url)).status).toBe(403);
  });

  it("shows a business only its own objects", async () => {
    const { object } = await put(B);
    const seen = await app.withTenant(A, (client) =>
      client.query("select 1 from storage.object where key = $1", [object.key]),
    );
    expect(seen.rows).toEqual([]);
  });

  it("refuses an upload outside a tenant, before anything is sent", async () => {
    const image = await photo();
    // RLS's with-check refuses the row: there is no business it could belong to.
    await expect(app.tx((client) => storage.putImage(client, image, null))).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("rolls the row back when the store refuses the bytes", async () => {
    const refused = createStorage({ ...CONFIG, secretAccessKey: "0".repeat(64) });
    // A colour no other test stores, so the hash names this upload only.
    const image = await photo("#123456");
    await expect(
      app.withTenant(B, (client) => refused.putImage(client, image, null)),
    ).rejects.toBeInstanceOf(StorageError);
    const stored = await app.withTenant(B, (client) =>
      client.query("select 1 from storage.object where sha256 = $1", [
        createHash("sha256").update(image.bytes).digest(),
      ]),
    );
    expect(stored.rows).toEqual([]);
  });

  it("never lets the app change or delete an object row", async () => {
    await put();
    for (const sql of ["update storage.object set bytes = 1", "delete from storage.object"]) {
      await expect(app.withTenant(A, (client) => client.query(sql))).rejects.toMatchObject({
        code: "42501",
      });
    }
  });
});
