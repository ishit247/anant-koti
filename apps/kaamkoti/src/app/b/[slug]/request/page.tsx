import { IMAGE_TYPES } from "@bodhchakra/storage";
import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import {
  type IntakeError,
  MAX_ITEM_DETAILS,
  MAX_ITEM_TITLE,
  MAX_REQUEST_ITEMS,
  MAX_REQUEST_PHOTOS,
} from "../../../../intake.ts";
import { formatPrice } from "../../../../price.ts";
import { publicPage } from "../../../../public-page.ts";
import { server } from "../../../../server.ts";
import { RequestForm } from "./request-form.tsx";

// No credential: the slug opens one business and only its public columns are read. The form posts to
// ./send (scope public-intake) as one multipart post.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "public-slug" });

const ERRORS: Record<Exclude<IntakeError, "not_found">, string> = {
  contact: "Please check your name, a 10-digit mobile number and the address.",
  location: "Your location could not be read. Please try again, or leave it out.",
  items: "Please add at least one work item, each with a title.",
  too_many_photos: `Please send at most ${MAX_REQUEST_PHOTOS} photos in all.`,
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
  const refused = error && error in ERRORS ? ERRORS[error as keyof typeof ERRORS] : null;
  return (
    <>
      <header className="hero">
        <p className="who">
          <span className="avatar" aria-hidden="true">
            {page.name.trim().charAt(0).toUpperCase()}
          </span>
          <span>
            {page.name}
            <span className="muted small"> · {page.city}</span>
          </span>
        </p>
        <h1>Request a visit</h1>
        <p className="muted">
          Tell {page.name} what needs doing. You will get a quote by link before any work starts.
        </p>
      </header>
      <RequestForm
        action={`/b/${encodeURIComponent(slug)}/request/send`}
        services={page.services.map((s) => ({ name: s.name, price: formatPrice(s.price, s.unit) }))}
        imageTypes={IMAGE_TYPES.join(",")}
        limits={{
          items: MAX_REQUEST_ITEMS,
          photos: MAX_REQUEST_PHOTOS,
          title: MAX_ITEM_TITLE,
          details: MAX_ITEM_DETAILS,
        }}
        refused={refused}
      />
    </>
  );
}
