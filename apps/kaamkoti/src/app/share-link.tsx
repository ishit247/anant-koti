"use client";
// A link the owner passes on: shown to copy, and as a WhatsApp message.
export function ShareLink({
  link,
  message,
  label,
}: {
  /** Absolute. */
  link: string;
  /** The WhatsApp text; the link is added after it. */
  message: string;
  label: string;
}) {
  return (
    <div className="share">
      <input readOnly value={link} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="quiet" onClick={() => navigator.clipboard.writeText(link)}>
        Copy
      </button>
      <a
        className="button"
        href={`https://wa.me/?text=${encodeURIComponent(`${message} ${link}`)}`}
      >
        WhatsApp
      </a>
    </div>
  );
}
