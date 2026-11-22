# @bodhchakra/storage

Uploads to a private Garage bucket, and presigned reads of them (docs/architecture.md 10). Layer: core.
Uploads go through the app server, never browser-to-bucket, so every check runs on our side.

## API

| Export                        | What it does                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `checkImage(bytes)`           | → `{ ok: true, image }` or `{ ok: false, reason: "too_large" \| "not_an_image" }`. Run before any write.   |
| `createStorage(config)`       | A client for one bucket: `{ endpoint, publicEndpoint, region, accessKeyId, secretAccessKey, bucket }`.     |
| `putImage(client, image, by)` | Inside `withTenant`: records `storage.object` for the current business, then PUTs the bytes. → the object. |
| `signedUrl(object)`           | A GET URL for one object, valid `SIGNED_URL_SECONDS` (300), signed for `publicEndpoint`.                   |
| `migrations`                  | `storage/0001_object.sql`; an app lists it before its own tables, which reference `storage.object`.        |

## Rules it enforces

- **The type is judged by magic bytes**: JPEG, PNG and WebP up to 10 MB (`MAX_IMAGE_BYTES`). A file's name and
  declared type are never read, and no other format reaches a decoder (no SVG, TIFF or HEIF parsing of
  customer input). A file that then fails to decode is refused.
- **Every image is re-encoded**: EXIF and other metadata are dropped (a phone photo's GPS position is a
  customer's home), the EXIF orientation is applied first, and the longest side is cut to 2048 px. This is why
  the module depends on `sharp`.
- **Keys are random** (`<uuid>.<format>`), never a file name. `storage.object` keeps business, bucket, key,
  type, size, the SHA-256 of the stored bytes and the uploading member (null for a customer).
- **RLS** scopes rows to the business. The runtime role may insert and select only; nothing changes an object.
  Composite foreign keys (`business_id, object_id`) let an app row name only its own business's objects.
- **The row is written before the bytes**: a refused PUT rolls the row back. A transaction that fails after the
  PUT leaves an unreferenced object in the bucket, never a row without bytes.
- **Nothing is public.** The bucket has no website access; an unsigned GET and an anonymous listing are refused
  by Garage (tested). Issue `signedUrl` only after the route's scope check.

## Config

The app passes its Garage key from its own config (`S3_*`). Each process holds one key with only the rights it
needs: Kaam Koti's web key has read and write on `kaamkoti-private`, and no owner right. In development
`pnpm run up` creates the bucket and imports the key from `apps/kaamkoti/.env.development`.
