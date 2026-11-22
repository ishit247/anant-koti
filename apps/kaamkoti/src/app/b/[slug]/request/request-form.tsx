"use client";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Icon } from "../../../icons.tsx";
import { PlaceFields } from "../../place-fields.tsx";

// Two screens in one form: the request (where and who, the list of work items) and the editor of one work
// item. Every item's fields stay in the form while hidden, so the post carries them all, photos included.
// The route handler checks everything again; what this component refuses is only a convenience.

/** One of the customer's saved addresses, as the form shows it. */
export interface BookEntry {
  readonly id: string;
  readonly label: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly address: string;
}

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
  readonly address: number;
  readonly label: number;
  readonly addresses: number;
}

interface Item {
  readonly key: number;
  readonly title: string;
  readonly details: string;
  /** Object URLs of the chosen photos, for the previews. Not revoked: a page holds at most a few. */
  readonly previews: readonly string[];
}

/** As the server compares names: case and spacing do not matter. */
const sameName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export function RequestForm({
  own,
  book,
  action,
  placeAction,
  services,
  imageTypes,
  limits,
  errors,
  refused,
}: {
  /** The customer's own name and mobile here; null before their first request. */
  own: { name: string; phone: string } | null;
  /** Their saved addresses, the most recently used first. */
  book: readonly BookEntry[];
  action: string;
  /** Where a picked point is sent to get its address back (D16). */
  placeAction: string;
  services: readonly Service[];
  imageTypes: string;
  limits: RequestLimits;
  /** The server's refusals by code, in words. */
  errors: Readonly<Record<string, string>>;
  /** The server's reason for refusing the last plain (no JavaScript) post, in words. */
  refused: string | null;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [itemProblem, setItemProblem] = useState<string | null>(null);
  /** A saved address's id, or "" for somewhere else; the last used is preselected. */
  const [where, setWhere] = useState(book[0]?.id ?? "");
  const roomInBook = book.length < limits.addresses;
  const [saveAddress, setSaveAddress] = useState(roomInBook);
  const [sending, setSending] = useState(false);
  const nextKey = useRef(0);
  const files = useRef(new Map<number, HTMLInputElement>());
  const titles = useRef(new Map<number, HTMLInputElement>());
  /** The item as it was when the editor opened, so Back can undo; null for a new item. */
  const before = useRef<{ item: Item; files: FileList | null } | null>(null);

  // Each screen starts at its top; a new item's editor puts the cursor in the title.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    if (editing !== null && !before.current) titles.current.get(editing)?.focus();
  }, [editing]);

  const prices = new Map(services.map((s) => [sameName(s.name), s.price]));
  const priceOf = (title: string) => prices.get(sameName(title)) ?? null;
  const photosIn = (list: readonly Item[]) => list.reduce((n, item) => n + item.previews.length, 0);
  const change = (key: number, update: Partial<Omit<Item, "key">>) =>
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...update } : item)));
  const drop = (key: number) => setItems((list) => list.filter((item) => item.key !== key));

  const add = () => {
    if (items.length >= limits.items) {
      setProblem(`A request can have up to ${limits.items} work items.`);
      return;
    }
    const key = nextKey.current++;
    setItems((list) => [...list, { key, title: "", details: "", previews: [] }]);
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
    if (!saved) drop(key);
    else {
      change(key, saved.item);
      const input = files.current.get(key);
      if (input) input.files = saved.files ?? new DataTransfer().files;
    }
    setEditing(null);
  };

  const remove = () => {
    if (editing !== null) drop(editing);
    setEditing(null);
  };

  const save = () => {
    const item = items.find((i) => i.key === editing);
    if (!item) return;
    if (!item.title.trim()) {
      setItemProblem("Say what needs doing, like “AC service”.");
      titles.current.get(item.key)?.focus();
      return;
    }
    if (photosIn(items) > limits.photos) {
      setItemProblem(`Please send at most ${limits.photos} photos in all.`);
      return;
    }
    setProblem(null);
    setEditing(null);
  };

  // Sent with fetch so that a refusal keeps what was typed and the chosen photos, which a reload would lose.
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (items.length === 0) {
      setProblem("Add at least one work item.");
      return;
    }
    setSending(true);
    const refuse = (reason: string) => {
      setProblem(reason);
      setSending(false);
      window.scrollTo({ top: 0 });
    };
    try {
      const response = await fetch(action, {
        method: "POST",
        headers: { accept: "application/json" },
        body: new FormData(event.currentTarget),
      });
      if (response.headers.get("content-type")?.startsWith("application/json")) {
        const answer = (await response.json()) as { location?: string; error?: string };
        if (answer.location) window.location.assign(answer.location);
        else
          refuse(errors[answer.error ?? ""] ?? "The request could not be sent. Please try again.");
      } else
        refuse(
          (await response.text()).trim() || "The request could not be sent. Please try again.",
        );
    } catch {
      // Documented fallback: offline or the connection dropped; everything typed stays for another try.
      refuse("The request could not be sent. Check your connection and try again.");
    }
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

        <section className="panel" aria-labelledby="where-title">
          <h2 id="where-title">Where and who</h2>
          {book.length > 0 ? (
            <div className="choices" role="radiogroup" aria-labelledby="where-title">
              {book.map((entry) => (
                <label key={entry.id} className="choice place">
                  <input
                    type="radio"
                    name="addressId"
                    value={entry.id}
                    checked={where === entry.id}
                    onChange={() => setWhere(entry.id)}
                  />
                  <span className="text">
                    <strong>
                      {entry.label} · {entry.contactName} · {entry.contactPhone}
                    </strong>
                    <span className="muted small">{entry.address}</span>
                  </span>
                </label>
              ))}
              <label className="choice place">
                <input
                  type="radio"
                  name="addressId"
                  value=""
                  checked={where === ""}
                  onChange={() => setWhere("")}
                />
                <span className="text">
                  <strong>Somewhere else</strong>
                  <span className="muted small">Another place, or someone else to meet</span>
                </span>
              </label>
            </div>
          ) : null}
          {where === "" ? (
            <>
              <PlaceFields
                // A first place is most likely the customer's own home, so their details start it.
                defaults={
                  book.length === 0 ? { contactName: own?.name, contactPhone: own?.phone } : {}
                }
                placeAction={placeAction}
                maxAddress={limits.address}
                self={own === null}
              />
              {roomInBook ? (
                <>
                  <label className="choice">
                    <input
                      type="checkbox"
                      name="saveAddress"
                      checked={saveAddress}
                      onChange={(e) => setSaveAddress(e.target.checked)}
                    />
                    Save for next time
                  </label>
                  {saveAddress ? (
                    <label>
                      Save as
                      <input
                        name="label"
                        required
                        maxLength={limits.label}
                        placeholder="Home, Parents, Shop"
                        defaultValue={book.length === 0 ? "Home" : undefined}
                      />
                    </label>
                  ) : null}
                </>
              ) : (
                <p className="hint">
                  Your address book is full ({limits.addresses}). Delete one on your profile to save
                  another.
                </p>
              )}
            </>
          ) : null}
        </section>

        <section className="panel" aria-labelledby="work-title">
          <h2 id="work-title">
            Work needed
            {items.length > 0 ? <span className="count">{items.length}</span> : null}
          </h2>
          {items.map((item) => {
            const price = priceOf(item.title);
            const [first] = item.previews;
            return (
              <button key={item.key} type="button" className="tile" onClick={() => open(item)}>
                {first ? (
                  // biome-ignore lint/performance/noImgElement: a local preview (object URL), never served
                  <img className="thumb" src={first} alt="" />
                ) : (
                  <span className="thumb">
                    <Icon name="wrench" />
                  </span>
                )}
                <span className="text">
                  <strong>{item.title}</strong>
                  <span className="muted small">
                    {item.details ||
                      (item.previews.length > 0
                        ? `${item.previews.length} photo${item.previews.length === 1 ? "" : "s"}`
                        : "Tap to add details")}
                  </span>
                </span>
                <span className={price ? "price" : "price ask"}>{price ?? "Quote"}</span>
                <Icon name="chevron" size={18} />
              </button>
            );
          })}
          <button type="button" className="add" onClick={add}>
            <Icon name="plus" size={18} />
            Add work item
          </button>
        </section>

        <div className="dock">
          <button type="submit" disabled={sending}>
            {sending ? "Sending…" : "Send request"}
          </button>
          <p className="muted small">Free to ask. You get a quote before any work starts.</p>
        </div>
      </div>

      {items.map((item, i) => {
        const price = priceOf(item.title);
        return (
          <fieldset key={item.key} className="sheet" hidden={editing !== item.key}>
            <legend className="visually-hidden">Work item</legend>
            <div className="sheet-head">
              <button type="button" className="icon" aria-label="Back" onClick={back}>
                <Icon name="back" size={22} />
              </button>
              <h2>{before.current ? "Edit work item" : "Add work item"}</h2>
            </div>
            <div className="panel">
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
                  placeholder="Pick a service or type your own"
                  value={item.title}
                  onChange={(e) => change(item.key, { title: e.target.value })}
                />
              </label>
              {item.title.trim() ? (
                <p className="hint">
                  {price ? (
                    <>
                      <strong>{price}</strong> from the price list
                    </>
                  ) : (
                    "The business will quote a price for this."
                  )}
                </p>
              ) : null}
              <label>
                Details (optional)
                <textarea
                  name={`item.${i}.details`}
                  maxLength={limits.details}
                  rows={4}
                  placeholder="What is wrong, which room, brand or model…"
                  value={item.details}
                  onChange={(e) => change(item.key, { details: e.target.value })}
                />
              </label>
              <label className="drop">
                <Icon name="camera" size={28} />
                <span>Photos (optional)</span>
                <span className="muted small">
                  Up to {limits.photos} in all. A photo helps the quote.
                </span>
                <input
                  ref={(el) => {
                    if (el) files.current.set(item.key, el);
                    else files.current.delete(item.key);
                  }}
                  className="visually-hidden"
                  type="file"
                  name={`item.${i}.photo`}
                  accept={imageTypes}
                  multiple
                  onChange={(e) =>
                    change(item.key, {
                      previews: Array.from(e.target.files ?? [], (f) => URL.createObjectURL(f)),
                    })
                  }
                />
              </label>
              {item.previews.length > 0 ? (
                <div className="thumbs">
                  {item.previews.map((src, n) => (
                    // biome-ignore lint/performance/noImgElement: a local preview (object URL), never served
                    <img key={src} src={src} alt={`Chosen ${n + 1} of ${item.previews.length}`} />
                  ))}
                </div>
              ) : null}
            </div>
            {itemProblem ? (
              <p className="error" role="alert">
                {itemProblem}
              </p>
            ) : null}
            <div className="dock">
              <button type="button" onClick={save}>
                Save
              </button>
              {before.current ? (
                <button type="button" className="danger" onClick={remove}>
                  Remove this item
                </button>
              ) : null}
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
