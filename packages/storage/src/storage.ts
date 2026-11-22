// Private objects in Garage (docs/architecture.md 10). Uploads go through the server, which has already checked
// the file (checkImage); a browser only ever reads one object, by a presigned GET issued after the route's scope
// check. The key this client holds has read and write on its one bucket and nothing else; the store enforces it.
import { createHash, randomUUID } from "node:crypto";
import type { DbClient } from "@bodhchakra/db";
import type { CheckedImage } from "./image.ts";
import { type Credentials, encodePath, presignGet, signRequest } from "./sigv4.ts";

export interface StorageConfig extends Credentials {
  /** Origin of the S3 API as this process reaches it. */
  readonly endpoint: string;
  /** Origin of the S3 API as a browser reaches it; presigned URLs are signed for this host. */
  readonly publicEndpoint: string;
  readonly bucket: string;
}

/** How long a presigned GET works. */
export const SIGNED_URL_SECONDS = 300;

export interface StoredObject {
  readonly id: string;
  readonly key: string;
  readonly contentType: string;
  readonly bytes: number;
}

/** A refused or failed S3 call. Carries the store's error code, never a credential. */
export class StorageError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(operation: string, status: number, code: string) {
    super(`storage: ${operation} failed with ${status} ${code}`);
    this.name = "StorageError";
    this.status = status;
    this.code = code;
  }
}

async function errorCode(response: Response): Promise<string> {
  return /<Code>([^<]+)<\/Code>/.exec(await response.text())?.[1] ?? "NoErrorCode";
}

export function createStorage(config: StorageConfig) {
  const objectUrl = (origin: string, key: string) =>
    new URL(`${new URL(origin).origin}/${encodePath(config.bucket)}/${encodePath(key)}`);

  return {
    /**
     * Records a checked image for the current business and stores its bytes. Runs inside `withTenant`. The row is
     * written first, so a failed put rolls it back with the caller's transaction; a transaction that fails after
     * the put leaves an unreferenced object in the bucket, never a row without bytes.
     */
    async putImage(
      client: DbClient,
      image: CheckedImage,
      createdBy: string | null,
    ): Promise<StoredObject> {
      const key = `${randomUUID()}.${image.extension}`;
      const sha256 = createHash("sha256").update(image.bytes).digest();
      const { rows } = await client.query<{ id: string }>(
        `insert into storage.object (business_id, bucket, key, content_type, bytes, sha256, created_by)
         values (nullif(current_setting('app.business_id', true), '')::uuid, $1, $2, $3, $4, $5, $6)
         returning id`,
        [config.bucket, key, image.contentType, image.bytes.byteLength, sha256, createdBy],
      );
      const row = rows[0];
      if (!row) throw new Error("storage: the object insert returned no row");
      const url = objectUrl(config.endpoint, key);
      const headers = signRequest(
        config,
        "PUT",
        url,
        { "content-type": image.contentType },
        sha256.toString("hex"),
      );
      // A copy into a plain ArrayBuffer: fetch's types refuse a Buffer that may sit on a SharedArrayBuffer.
      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: Uint8Array.from(image.bytes),
      });
      if (!response.ok) throw new StorageError("put", response.status, await errorCode(response));
      await response.body?.cancel();
      return {
        id: row.id,
        key,
        contentType: image.contentType,
        bytes: image.bytes.byteLength,
      };
    },

    /** A URL a browser GETs one object from, for SIGNED_URL_SECONDS. Issue it only after the scope check. */
    signedUrl(object: { readonly key: string }): string {
      return presignGet(config, objectUrl(config.publicEndpoint, object.key), SIGNED_URL_SECONDS)
        .href;
    },
  };
}

export type Storage = ReturnType<typeof createStorage>;
