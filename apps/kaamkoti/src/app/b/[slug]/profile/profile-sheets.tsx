"use client";
import { type ReactNode, useState } from "react";
import { Icon } from "../../../icons.tsx";
import { PlaceFields } from "../../place-fields.tsx";

// Profile's two lists of things to edit: the customer's own name and mobile, and their saved addresses. Each
// opens a sheet that is its own form, posting to ./details or ./address; Back closes it and throws away what
// was typed (the sheet is re-mounted).

export interface ProfileAddress {
  readonly id: string;
  readonly label: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly address: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export function ProfileSheets({
  own,
  signedInWith,
  book,
  detailsAction,
  addressAction,
  placeAction,
  limits,
  message,
  children,
}: {
  /** Null before the first request, when there is nothing to edit yet. */
  own: { name: string; phone: string } | null;
  /** What the person signs in with: their email, else their mobile as typed in India. */
  signedInWith: string;
  book: readonly ProfileAddress[];
  detailsAction: string;
  addressAction: string;
  placeAction: string;
  limits: { address: number; label: number; addresses: number };
  /** What the last post did, or why it was refused, in words. */
  message: { text: string; error: boolean } | null;
  /** The rest of the main view (sign out). */
  children: ReactNode;
}) {
  /** "details", an address id, "new", or null for the main view. */
  const [open, setShown] = useState<string | null>(null);
  /** Bumped on Back, so closed sheets start again from what is saved. */
  const [generation, setGeneration] = useState(0);
  const [saving, setSaving] = useState(false);
  // Each screen starts at its top.
  const setOpen = (key: string | null) => {
    setShown(key);
    window.scrollTo({ top: 0 });
  };

  const back = () => {
    setOpen(null);
    setGeneration((n) => n + 1);
  };
  const head = (title: string) => (
    <div className="sheet-head">
      <button type="button" className="icon" aria-label="Back" onClick={back}>
        <Icon name="back" size={22} />
      </button>
      <h2>{title}</h2>
    </div>
  );
  const sheet = (key: string, action: string, title: string, body: ReactNode, dock: ReactNode) => (
    <form
      key={`${key}:${generation}`}
      className="sheet"
      method="post"
      action={action}
      hidden={open !== key}
      onSubmit={() => setSaving(true)}
    >
      {head(title)}
      <div className="panel">{body}</div>
      <div className="dock">{dock}</div>
    </form>
  );

  return (
    <>
      <div className="stack" hidden={open !== null}>
        {message ? (
          <p className={message.error ? "error" : "hint"} role={message.error ? "alert" : "status"}>
            {message.text}
          </p>
        ) : null}
        <section className="panel" aria-labelledby="you-title">
          <h2 id="you-title">You</h2>
          <dl className="facts">
            {own ? (
              <>
                <div>
                  <dt>Name</dt>
                  <dd>{own.name}</dd>
                </div>
                <div>
                  <dt>Mobile</dt>
                  <dd>{own.phone}</dd>
                </div>
              </>
            ) : null}
            <div>
              <dt>Signed in with</dt>
              <dd>{signedInWith}</dd>
            </div>
          </dl>
          {own ? (
            <button type="button" className="quiet" onClick={() => setOpen("details")}>
              Edit
            </button>
          ) : (
            <p className="muted small">
              Your name and mobile are saved with your first request, and so is its address.
            </p>
          )}
        </section>

        {own ? (
          <section className="panel" aria-labelledby="addresses-title">
            <h2 id="addresses-title">
              Addresses
              {book.length > 0 ? <span className="count">{book.length}</span> : null}
            </h2>
            {book.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="tile"
                onClick={() => setOpen(entry.id)}
              >
                <span className="thumb">
                  <Icon name="pin" />
                </span>
                <span className="text">
                  <strong>
                    {entry.label} · {entry.contactName}
                  </strong>
                  <span className="muted small">{entry.address}</span>
                </span>
                <span />
                <Icon name="chevron" size={18} />
              </button>
            ))}
            {book.length < limits.addresses ? (
              <button type="button" className="add" onClick={() => setOpen("new")}>
                <Icon name="plus" size={18} />
                Add address
              </button>
            ) : (
              <p className="hint">Up to {limits.addresses} addresses. Delete one to add another.</p>
            )}
          </section>
        ) : null}
        {children}
      </div>

      {own
        ? sheet(
            "details",
            detailsAction,
            "Your details",
            <>
              <label>
                Your name
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={120}
                  defaultValue={own.name}
                />
              </label>
              <label>
                Your mobile number
                <input
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  inputMode="tel"
                  required
                  defaultValue={own.phone}
                />
              </label>
            </>,
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>,
          )
        : null}
      {own
        ? book.map((entry) =>
            sheet(
              entry.id,
              addressAction,
              "Edit address",
              <>
                <input type="hidden" name="id" value={entry.id} />
                <PlaceFields
                  defaults={entry}
                  placeAction={placeAction}
                  maxAddress={limits.address}
                  maxLabel={limits.label}
                />
              </>,
              // Not disabled while sending: a disabled submitter's intent would be left out of the post.
              <>
                <button type="submit" name="intent" value="save">
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="submit"
                  name="intent"
                  value="delete"
                  className="danger"
                  formNoValidate
                >
                  Delete this address
                </button>
              </>,
            ),
          )
        : null}
      {own && book.length < limits.addresses
        ? sheet(
            "new",
            addressAction,
            "Add address",
            <PlaceFields
              defaults={{}}
              placeAction={placeAction}
              maxAddress={limits.address}
              maxLabel={limits.label}
            />,
            <button type="submit" name="intent" value="save">
              {saving ? "Saving…" : "Save"}
            </button>,
          )
        : null}
    </>
  );
}
