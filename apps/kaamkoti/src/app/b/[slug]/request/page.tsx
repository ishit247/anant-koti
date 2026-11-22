import { IMAGE_TYPES } from "@bodhchakra/storage";
import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { type IntakeError, MAX_REQUEST_PHOTOS } from "../../../../intake.ts";
import { formatPrice } from "../../../../price.ts";
import { publicPage } from "../../../../public-page.ts";
import { server } from "../../../../server.ts";

// No credential: the slug opens one business and only its public columns are read. The form posts to
// ./send (scope public-intake), a plain multipart post that works without JavaScript.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "public-slug" });

const ERRORS: Record<Exclude<IntakeError, "not_found">, string> = {
  contact: "Please check your name, a 10-digit mobile number and the address.",
  tasks: "Please pick at least one service.",
  answers: "Please answer the required questions.",
  too_many_photos: `Please send at most ${MAX_REQUEST_PHOTOS} photos.`,
  photo_too_large: "A photo is larger than 10 MB. Please send a smaller one.",
  photo_not_an_image: "Photos must be JPEG, PNG or WebP images.",
};

export default async function RequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug } = await params;
  const { error } = await searchParams;
  const page = await publicPage(server().db, slug);
  if (!page) notFound();
  const message = error && error in ERRORS ? ERRORS[error as keyof typeof ERRORS] : null;
  return (
    <>
      <p className="muted">{page.name}</p>
      <h1>Request a visit</h1>
      <form
        method="post"
        action={`/b/${encodeURIComponent(slug)}/request/send`}
        encType="multipart/form-data"
      >
        {message ? (
          <p className="error" role="alert">
            {message}
          </p>
        ) : null}
        <fieldset className="item">
          <legend>What do you need?</legend>
          {page.services.map((s) => (
            <label key={s.id} className="choice">
              <input type="checkbox" name="task" value={s.id} />
              <span>
                {s.name} <span className="muted">· {formatPrice(s.unitPriceMinor, s.unit)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {page.questions.map((q) => {
          const label = `${q.label}${q.required ? "" : " (optional)"}`;
          if (q.type === "choice")
            return (
              <label key={q.key}>
                {label}
                <select name={`q.${q.key}`} required={q.required} defaultValue="">
                  <option value="" disabled={q.required}>
                    Choose…
                  </option>
                  {q.options.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              </label>
            );
          if (q.type === "photo")
            return (
              <label key={q.key}>
                {label}
                <input
                  type="file"
                  name={`photo.${q.key}`}
                  accept={IMAGE_TYPES.join(",")}
                  multiple
                  required={q.required}
                />
              </label>
            );
          return (
            <label key={q.key}>
              {label}
              <input
                name={`q.${q.key}`}
                required={q.required}
                {...(q.type === "number"
                  ? { type: "number", inputMode: "decimal", min: 0 }
                  : { maxLength: 1000 })}
              />
            </label>
          );
        })}
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
        <label>
          When suits you? (optional)
          <input
            name="preferredWindow"
            maxLength={200}
            placeholder="For example, weekday mornings"
          />
        </label>
        <button type="submit">Send request</button>
      </form>
    </>
  );
}
