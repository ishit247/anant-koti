import type { WorkItem } from "../job.ts";

/**
 * The work a request asks for, as cards: title, whether the price list covers it, details and photos. `sign`
 * issues the photo URLs; call it only after the page has checked the job is the viewer's to see.
 */
export function WorkItems({
  items,
  sign,
  photoAlt,
}: {
  items: readonly WorkItem[];
  sign: (photo: { readonly key: string }) => string;
  photoAlt: string;
}) {
  return (
    <ul className="cards">
      {items.map((item) => (
        <li key={item.id} className="card">
          <strong>{item.title}</strong>
          <span className="muted small">
            {item.listed ? "From the price list" : "Price to be quoted"}
          </span>
          {item.details ? <span>{item.details}</span> : null}
          {item.photos.length > 0 ? (
            <div className="photos">
              {item.photos.map((photo) => (
                // biome-ignore lint/performance/noImgElement: a presigned URL, not an asset Next can optimise
                <img key={photo.key} src={sign(photo)} alt={photoAlt} loading="lazy" />
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
