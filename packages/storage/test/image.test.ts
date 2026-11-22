import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { checkImage, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from "../src/index.ts";

const picture = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#3a7d5c" } });

async function accepted(input: Uint8Array) {
  const result = await checkImage(input);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.image;
}

describe("checkImage", () => {
  it("accepts JPEG, PNG and WebP, and keeps the format each arrived in", async () => {
    for (const [format, type] of [
      ["jpeg", "image/jpeg"],
      ["png", "image/png"],
      ["webp", "image/webp"],
    ] as const) {
      const image = await accepted(await picture(40, 30).toFormat(format).toBuffer());
      expect(image.contentType).toBe(type);
      expect(image.extension).toBe(format);
      expect((await sharp(image.bytes).metadata()).format).toBe(format);
    }
  });

  it("drops EXIF, so a phone photo's GPS position is not stored", async () => {
    const withGps = await picture(40, 30)
      .jpeg()
      .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "18/1 31/1 0/1" } })
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();
    const image = await accepted(withGps);
    expect((await sharp(image.bytes).metadata()).exif).toBeUndefined();
  });

  it("scales the longest side down to 2048 px and leaves a smaller image its size", async () => {
    const large = await accepted(await picture(3000, 1500).png().toBuffer());
    expect(await sharp(large.bytes).metadata()).toMatchObject({
      width: MAX_IMAGE_SIDE,
      height: 1024,
    });
    const small = await accepted(await picture(640, 480).png().toBuffer());
    expect(await sharp(small.bytes).metadata()).toMatchObject({ width: 640, height: 480 });
  });

  it("judges the type by the bytes: text is refused whatever the file was called", async () => {
    expect(await checkImage(Buffer.from("<svg onload=alert(1)></svg>"))).toEqual({
      ok: false,
      reason: "not_an_image",
    });
  });

  it("refuses an image type it does not accept", async () => {
    const gif = await picture(10, 10).gif().toBuffer();
    expect(await checkImage(gif)).toEqual({ ok: false, reason: "not_an_image" });
  });

  it("refuses a JPEG header on bytes that are not a JPEG", async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
    expect(await checkImage(fake)).toEqual({ ok: false, reason: "not_an_image" });
  });

  it("refuses a PNG header in front of a JPEG", async () => {
    const jpeg = await picture(20, 20).jpeg().toBuffer();
    const disguised = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      jpeg,
    ]);
    expect(await checkImage(disguised)).toEqual({ ok: false, reason: "not_an_image" });
  });

  it("refuses a file over 10 MB, and takes one of exactly 10 MB to the decoder", async () => {
    const header = [0xff, 0xd8, 0xff, 0xe0];
    const over = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    over.set(header);
    expect(await checkImage(over)).toEqual({ ok: false, reason: "too_large" });
    const atLimit = Buffer.alloc(MAX_IMAGE_BYTES);
    atLimit.set(header);
    expect(await checkImage(atLimit)).toEqual({ ok: false, reason: "not_an_image" });
  });
});
