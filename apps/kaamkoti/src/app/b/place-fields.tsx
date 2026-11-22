"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons.tsx";

// Where the work is and whom to meet there: the fields of one place, as the request form's "Somewhere else"
// and the Profile's address sheets post them (address-book.ts, readPlaceForm). "Use my current location" puts
// the point in hidden fields and asks the server for its address (D16), for the customer to correct.

export interface PlaceDefaults {
  readonly label?: string;
  readonly contactName?: string;
  readonly contactPhone?: string;
  readonly address?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export function PlaceFields({
  defaults,
  placeAction,
  maxAddress,
  maxLabel,
  self,
}: {
  defaults: PlaceDefaults;
  /** Where a picked point is sent to get its address back. */
  placeAction: string;
  maxAddress: number;
  /** Shows the label field ("Home, Parents, Shop") with this limit; omitted, there is none. */
  maxLabel?: number;
  /** A first request: the person is the customer themselves. */
  self?: boolean;
}) {
  const [place, setPlace] = useState<{ latitude: string; longitude: string } | null>(
    defaults.latitude !== undefined && defaults.longitude !== undefined
      ? { latitude: String(defaults.latitude), longitude: String(defaults.longitude) }
      : null,
  );
  /** "found": the address box was filled from the picked point. */
  const [locating, setLocating] = useState<"idle" | "busy" | "found" | "failed">("idle");
  const addressBox = useRef<HTMLTextAreaElement>(null);
  const [canLocate, setCanLocate] = useState(false);
  // Known only in the browser; the server render offers no location button.
  useEffect(() => setCanLocate("geolocation" in navigator), []);

  /** The picked point's address in the Address box; false if none came back. */
  const fillAddress = async (latitude: number, longitude: number): Promise<boolean> => {
    try {
      const response = await fetch(placeAction, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ latitude, longitude }),
      });
      if (!response.ok) return false;
      const { address } = (await response.json()) as { address: string | null };
      if (!address || !addressBox.current) return false;
      addressBox.current.value = address;
      return true;
    } catch {
      // Documented fallback: offline or the lookup failed; the point is kept and the customer types the address.
      return false;
    }
  };

  const locate = () => {
    setLocating("busy");
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        setPlace({
          latitude: coords.latitude.toFixed(6),
          longitude: coords.longitude.toFixed(6),
        });
        setLocating((await fillAddress(coords.latitude, coords.longitude)) ? "found" : "idle");
      },
      // Refused or unavailable: the typed address is enough, and the message says so.
      () => setLocating("failed"),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  return (
    <>
      {maxLabel ? (
        <label>
          Save as
          <input
            name="label"
            required
            maxLength={maxLabel}
            placeholder="Home, Parents, Shop"
            defaultValue={defaults.label}
          />
        </label>
      ) : null}
      <label>
        {self ? "Your name" : "Person to meet"}
        <input
          name="contactName"
          autoComplete={self ? "name" : "off"}
          required
          maxLength={120}
          defaultValue={defaults.contactName}
        />
      </label>
      <label>
        {self ? "Your mobile number" : "Their mobile number"}
        <input
          name="contactPhone"
          type="tel"
          autoComplete={self ? "tel" : "off"}
          inputMode="tel"
          required
          defaultValue={defaults.contactPhone}
        />
      </label>
      <label>
        Address
        <textarea
          ref={addressBox}
          name="address"
          defaultValue={defaults.address}
          autoComplete="street-address"
          required
          maxLength={maxAddress}
          rows={3}
          placeholder="House, street, area"
        />
      </label>
      <input type="hidden" name="latitude" value={place?.latitude ?? ""} />
      <input type="hidden" name="longitude" value={place?.longitude ?? ""} />
      {place ? (
        <span className="pill" role="status">
          <Icon name="pin" size={16} />
          Location added
          <button type="button" aria-label="Remove location" onClick={() => setPlace(null)}>
            <Icon name="close" size={16} />
          </button>
        </span>
      ) : canLocate ? (
        <button type="button" className="link" onClick={locate} disabled={locating === "busy"}>
          <Icon name="pin" size={18} />
          {locating === "busy" ? "Finding you…" : "Use my current location"}
        </button>
      ) : null}
      {locating === "failed" && !place ? (
        <p className="hint" role="status">
          Could not get your location. The address is enough.
        </p>
      ) : place && locating === "found" ? (
        <p className="hint" role="status">
          Address filled in from your location. Add the house or flat number.
        </p>
      ) : place && locating === "idle" && defaults.latitude === undefined ? (
        <p className="hint" role="status">
          No address was found for your location. Please check the one above.
        </p>
      ) : null}
    </>
  );
}
