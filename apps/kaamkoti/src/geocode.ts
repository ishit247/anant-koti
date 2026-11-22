// The address of a point the customer picked with "Use my current location" (D16): OpenStreetMap's Nominatim,
// asked by this server so the customer's IP never reaches it. Their policy asks for an identifying User-Agent and
// at most one request a second from the whole app (the route's global limit).
import type { Logger } from "@bodhchakra/log";
import { z } from "zod";
import { MAX_ADDRESS } from "./address-book.ts";

export const point = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type Point = z.infer<typeof point>;

/** Nominatim's answer: `display_name` for a place, `error` ("Unable to geocode") for open sea and the like. */
const reverseAnswer = z.union([
  z.object({ display_name: z.string().min(1) }),
  z.object({ error: z.string() }),
]);

const TIMEOUT_MS = 5000;

export type Geocoder = (at: Point) => Promise<string | null>;

/**
 * Null when there is no address to offer, for any reason: nothing at that point, the service slow, down or
 * answering in a shape we do not know. A documented fallback: the customer types the address, which the form
 * asks for anyway, and the picked point is still sent.
 */
export function nominatim(baseUrl: string, log: Logger): Geocoder {
  return async ({ latitude, longitude }) => {
    const url = new URL("/reverse", baseUrl);
    url.search = new URLSearchParams({
      format: "jsonv2",
      lat: String(latitude),
      lon: String(longitude),
      zoom: "18",
    }).toString();
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "KaamKoti/1.0", "accept-language": "en-IN,en" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warn("geocoder answered with an error status", { status: response.status });
        return null;
      }
      const answer = reverseAnswer.safeParse(await response.json());
      if (!answer.success) {
        log.warn("geocoder answer not understood", { issues: answer.error.issues.length });
        return null;
      }
      return "display_name" in answer.data ? tidy(answer.data.display_name) : null;
    } catch (error) {
      // The point is not logged: it is where a customer lives.
      log.warn("geocoder unreachable", { error });
      return null;
    }
  };
}

/** Nominatim ends every Indian address with the country, which nobody writes on a door. */
function tidy(address: string): string {
  return address.replace(/,\s*India$/, "").slice(0, MAX_ADDRESS);
}
