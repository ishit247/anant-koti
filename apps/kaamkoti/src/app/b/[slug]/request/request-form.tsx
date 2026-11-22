"use client";
import { type FormEvent, useEffect, useRef, useState } from "react";

// Two views in one form: the request (contact, address, the list of work items) and the editor of one work
// item. Every item's fields stay in the form while hidden, so the post carries them all, photos included.
// The route handler checks everything again; what this component refuses is only a convenience.

export interface Service {
  readonly name: string;
  /** Formatted for the customer, like "₹800 per unit". */
  readonly price: string;
}

export interface RequestLimits {
  readonly items: number;
  readonly photos: number;
  readonly title: number;
  readonly details: number;
}

interface Item {
  readonly key: number;
  readonly title: string;
  readonly details: string;
  readonly photos: number;
}

/** As the server compares names: case and spacing do not matter. */
const sameName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export function RequestForm({
  action,
  services,
  imageTypes,
  limits,
  refused,
}: {
  action: string;
  services: readonly Service[];
  imageTypes: string;
  limits: RequestLimits;
  /** The server's reason for refusing the last post, in words. */
  refused: string | null;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [itemProblem, setItemProblem] = useState<string | null>(null);
  const [place, setPlace] = useState<{ latitude: string; longitude: string } | null>(null);
  const [locating, setLocating] = useState<"idle" | "busy" | "failed">("idle");
  const [canLocate, setCanLocate] = useState(false);
  const [sending, setSending] = useState(false);
  const nextKey = useRef(0);
  const files = useRef(new Map<number, HTMLInputElement>());
  const titles = useRef(new Map<number, HTMLInputElement>());
  /** The item as it was when the editor opened, so Back can undo; null for a new item. */
  const before = useRef<{ item: Item; files: FileList | null } | null>(null);

  // Known only in the browser; the server render offers no location button.
  useEffect(() => setCanLocate("geolocation" in navigator), []);
  useEffect(() => {
    if (editing !== null) titles.current.get(editing)?.focus();
  }, [editing]);

  const prices = new Map(services.map((s) => [sameName(s.name), s.price]));
  const priceOf = (title: string) => prices.get(sameName(title)) ?? null;
  const photosIn = (list: readonly Item[]) => list.reduce((n, item) => n + item.photos, 0);
  const change = (key: number, update: Partial<Omit<Item, "key">>) =>
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...update } : item)));

  const add = () => {
    if (items.length >= limits.items) {
      setProblem(`A request can have up to ${limits.items} work items.`);
      return;
    }
    const key = nextKey.current++;
    setItems((list) => [...list, { key, title: "", details: "", photos: 0 }]);
    before.current = null;
    setItemProblem(null);
    setEditing(key);
  };

  const open = (item: Item) => {
    before.current = { item, files: files.current.get(item.key)?.files ?? null };
    setItemProblem(null);
    setEditing(item.key);
  };

  const back = () => {
    const key = editing;
    if (key === null) return;
    const saved = before.current;
    if (!saved) setItems((list) => list.filter((item) => item.key !== key));
    else {
      change(key, saved.item);
      const input = files.current.get(key);
      if (input) input.files = saved.files ?? new DataTransfer().files;
    }
    setEditing(null);
  };

  const save = () => {
    const item = items.find((i) => i.key === editing);
    if (!item) return;
    if (!item.title.trim()) {
      setItemProblem("Say what needs doing, like “AC service”.");
      return;
    }
    if (photosIn(items) > limits.photos) {
      setItemProblem(`Please send at most ${limits.photos} photos in all.`);
      return;
    }
    setProblem(null);
    setEditing(null);
  };

  const locate = () => {
    setLocating("busy");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setPlace({
          latitude: coords.latitude.toFixed(6),
          longitude: coords.longitude.toFixed(6),
        });
        setLocating("idle");
      },
      // Refused or unavailable: the typed address is enough, and the message says so.
      () => setLocating("failed"),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (items.length === 0) {
      event.preventDefault();
      setProblem("Add at least one work item.");
      return;
    }
    setSending(true);
  };

  const message = problem ?? refused;
  return (
    <form method="post" action={action} encType="multipart/form-data" onSubmit={submit}>
      <div className="stack" hidden={editing !== null}>
        {message ? (
          <p className="error" role="alert">
            {message}
          </p>
        ) : null}
        <label>
          Your name
          <input name="name" autoComplete="name" required maxLength={120} />
        </label>
        <label>
          Mobile number
          <input name="phone" type="tel" autoComplete="tel" inputMode="tel" required />
        </label>
        <label>
          Address
          <textarea
            name="address"
            autoComplete="street-address"
            required
            maxLength={500}
            rows={3}
          />
        </label>
        <input type="hidden" name="latitude" value={place?.latitude ?? ""} />
        <input type="hidden" name="longitude" value={place?.longitude ?? ""} />
        {place ? (
          <div className="row">
            <span role="status">Your location is added.</span>
            <button type="button" className="quiet" onClick={() => setPlace(null)}>
              Remove
            </button>
          </div>
        ) : canLocate ? (
          <button type="button" className="quiet" onClick={locate} disabled={locating === "busy"}>
            {locating === "busy" ? "Finding you…" : "Use my location"}
          </button>
        ) : null}
        {locating === "failed" && !place ? (
          <p className="muted small" role="status">
            Could not get your location. The address is enough.
          </p>
        ) : null}

        <h2>Work needed</h2>
        {items.length === 0 ? (
          <p className="empty">
            Add each piece of work you need, like “AC service” or “Broken wire”.
          </p>
        ) : (
          <ul className="cards">
            {items.map((item) => (
              <li key={item.key} className="card">
                <strong>{item.title}</strong>
                <span className="muted small">
                  {[
                    priceOf(item.title) ?? "Price to be quoted",
                    item.photos > 0 ? `${item.photos} photo${item.photos === 1 ? "" : "s"}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {item.details ? <span className="small">{item.details}</span> : null}
                <div className="actions">
                  <button type="button" className="quiet" onClick={() => open(item)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => setItems((list) => list.filter((i) => i.key !== item.key))}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button type="button" className="quiet" onClick={add}>
            Add work item
          </button>
          <button type="submit" disabled={sending}>
            {sending ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>

      {items.map((item, i) => {
        const price = priceOf(item.title);
        return (
          <fieldset key={item.key} className="item" hidden={editing !== item.key}>
            <legend>Work item</legend>
            <label>
              What needs doing?
              <input
                ref={(el) => {
                  if (el) titles.current.set(item.key, el);
                  else titles.current.delete(item.key);
                }}
                name={`item.${i}.title`}
                list="services"
                autoComplete="off"
                maxLength={limits.title}
                value={item.title}
                onChange={(e) => change(item.key, { title: e.target.value })}
              />
            </label>
            {item.title.trim() ? (
              <p className="muted small">
                {price ? `${price}, from the price list.` : "The business will quote a price."}
              </p>
            ) : null}
            <label>
              Details (optional)
              <textarea
                name={`item.${i}.details`}
                maxLength={limits.details}
                rows={4}
                value={item.details}
                onChange={(e) => change(item.key, { details: e.target.value })}
              />
            </label>
            <label>
              Photos (optional)
              <input
                ref={(el) => {
                  if (el) files.current.set(item.key, el);
                  else files.current.delete(item.key);
                }}
                type="file"
                name={`item.${i}.photo`}
                accept={imageTypes}
                multiple
                onChange={(e) => change(item.key, { photos: e.target.files?.length ?? 0 })}
              />
            </label>
            <p className="muted small">Up to {limits.photos} photos in all.</p>
            {itemProblem ? (
              <p className="error" role="alert">
                {itemProblem}
              </p>
            ) : null}
            <div className="actions">
              <button type="button" className="quiet" onClick={back}>
                Back
              </button>
              <button type="button" onClick={save}>
                Save
              </button>
            </div>
          </fieldset>
        );
      })}
      <datalist id="services">
        {services.map((s) => (
          <option key={s.name} value={s.name} />
        ))}
      </datalist>
    </form>
  );
}
