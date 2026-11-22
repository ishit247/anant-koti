// The one check every uploaded image passes (docs/architecture.md 10): the type is judged by magic bytes, never
// by the file name or the declared type, and the image is decoded and re-encoded. Re-encoding drops EXIF and
// every other metadata block (a phone photo's GPS position is a customer's home) and bounds the size we keep.
import sharp from "sharp";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Longest side kept, in pixels; larger images are scaled down, smaller ones are left as they are. */
export const MAX_IMAGE_SIDE = 2048;

const TYPES = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
type Format = keyof typeof TYPES;
export type ImageType = (typeof TYPES)[Format];
export const IMAGE_TYPES: readonly ImageType[] = Object.values(TYPES);

/** An image that passed the check: re-encoded bytes in the format it arrived in. */
export interface CheckedImage {
  readonly bytes: Buffer;
  readonly contentType: ImageType;
  readonly extension: Format;
}

export type ImageCheck =
  | { readonly ok: true; readonly image: CheckedImage }
  | { readonly ok: false; readonly reason: "too_large" | "not_an_image" };

const startsWith = (bytes: Uint8Array, at: number, signature: readonly number[]) =>
  signature.every((b, i) => bytes[at + i] === b);

function sniff(bytes: Uint8Array): Format | null {
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  // "RIFF", four bytes of length, "WEBP".
  if (
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  )
    return "webp";
  return null;
}

/** Checks one file and returns the bytes to store, or why it is refused. */
export async function checkImage(input: Uint8Array): Promise<ImageCheck> {
  if (input.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
  const format = sniff(input);
  if (!format) return { ok: false, reason: "not_an_image" };
  let bytes: Buffer;
  try {
    // Only the three sniffed formats reach the decoder, which picks its format from the same magic bytes; no
    // other libvips decoder (SVG, TIFF, HEIF…) ever sees customer input. failOn "error": a truncated or corrupt
    // file is refused rather than stored half-decoded. Only the first frame of an animation is kept.
    bytes = await sharp(input, { failOn: "error" })
      .rotate() // applies the EXIF orientation before the metadata is dropped
      .resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, { fit: "inside", withoutEnlargement: true })
      .toFormat(format)
      .toBuffer();
  } catch {
    // Documented fallback: whatever sharp cannot decode is, for us, not an image. The file is the customer's
    // input, not our fault, so it is refused with a reason instead of failing the request.
    return { ok: false, reason: "not_an_image" };
  }
  return { ok: true, image: { bytes, contentType: TYPES[format], extension: format } };
}
