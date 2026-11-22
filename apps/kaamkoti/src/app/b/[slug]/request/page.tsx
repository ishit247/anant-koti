import { IMAGE_TYPES } from "@bodhchakra/storage";
import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { addressBook, MAX_ADDRESS, MAX_ADDRESSES, MAX_LABEL } from "../../../../address-book.ts";
import { customerContact } from "../../../../customer-space.ts";
import { withCustomer } from "../../../../guard.ts";
import {
  type IntakeError,
  MAX_ITEM_DETAILS,
  MAX_ITEM_TITLE,
  MAX_REQUEST_ITEMS,
  MAX_REQUEST_PHOTOS,
} from "../../../../intake.ts";
import { localPhone } from "../../../../phone.ts";
import { formatPrice } from "../../../../price.ts";
import { publicPage } from "../../../../public-page.ts";
import { server } from "../../../../server.ts";
import { BusinessHeader } from "../../../business-header.tsx";
import { CustomerNav } from "../../../customer-nav.tsx";
import { RequestForm } from "./request-form.tsx";

// A signed-in customer (D15) asks this business for work: at one of their saved addresses here, or somewhere
// else they type; the form posts to ./send (scope customer) as one multipart post.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

const ERRORS: Record<Exclude<IntakeError, "not_found">, string> = {
  contact: "Please check the name, a 10-digit mobile number, the address and what to save it as.",
  phone_taken:
    "This mobile number is on another customer's record here. Use your own number, or call the business.",
  location: "Your location could not be read. Please try again, or leave it out.",
  address: "That address is no longer in your address book. Please choose again.",
  addresses_full: `Your address book is full (${MAX_ADDRESSES}). Untick "Save for next time", or delete one on your profile.`,
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
  const space = `/b/${encodeURIComponent(slug)}`;
  const { own, book } = await withCustomer(slug, `${space}/request`, async (client, customer) => ({
    own: customer ? await customerContact(client, customer) : null,
    book: customer ? await addressBook(client, customer) : [],
  }));
  const page = await publicPage(server().db, slug);
  if (!page) notFound();
  const refused = error && error in ERRORS ? ERRORS[error as keyof typeof ERRORS] : null;
  return (
    <>
      <BusinessHeader business={page} home={{ href: space }}>
        <h1>New work</h1>
        <p className="muted">
          Tell {page.name} what needs doing. You will get a quote before any work starts.
        </p>
      </BusinessHeader>
      <RequestForm
        own={own}
        book={book.map((entry) => ({
          id: entry.id,
          label: entry.label,
          contactName: entry.contactName,
          contactPhone: localPhone(entry.contactPhone),
          address: entry.address,
        }))}
        action={`${space}/request/send`}
        placeAction={`${space}/request/place`}
        services={page.services.map((s) => ({ name: s.name, price: formatPrice(s.price, s.unit) }))}
        imageTypes={IMAGE_TYPES.join(",")}
        limits={{
          items: MAX_REQUEST_ITEMS,
          photos: MAX_REQUEST_PHOTOS,
          title: MAX_ITEM_TITLE,
          details: MAX_ITEM_DETAILS,
          address: MAX_ADDRESS,
          label: MAX_LABEL,
          addresses: MAX_ADDRESSES,
        }}
        refused={refused}
      />
      <CustomerNav space={space} />
    </>
  );
}
