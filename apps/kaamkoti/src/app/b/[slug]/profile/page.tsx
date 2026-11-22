import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { addressBook, MAX_ADDRESS, MAX_ADDRESSES, MAX_LABEL } from "../../../../address-book.ts";
import { customerContact } from "../../../../customer-space.ts";
import { withCustomer } from "../../../../guard.ts";
import { localPhone } from "../../../../phone.ts";
import { publicPage } from "../../../../public-page.ts";
import { server } from "../../../../server.ts";
import { BusinessHeader } from "../../../business-header.tsx";
import { CustomerNav } from "../../../customer-nav.tsx";
import { ProfileSheets } from "./profile-sheets.tsx";

// The signed-in customer's own details with this business (D15): their name and mobile, edited only here, their
// address book, and the one way to sign out. The sheets post to ./details and ./address (scope customer).
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

const MESSAGES: Record<string, { text: string; error: boolean }> = {
  "saved:details": { text: "Your details are saved.", error: false },
  "saved:address": { text: "The address is saved.", error: false },
  "saved:deleted": { text: "The address is deleted.", error: false },
  "error:contact": {
    text: "Please check the name, a 10-digit mobile number, the address and what to save it as.",
    error: true,
  },
  "error:phone_taken": {
    text: "This mobile number is on another customer's record here. Use your own number, or call the business.",
    error: true,
  },
  "error:location": {
    text: "Your location could not be read. Please try again, or leave it out.",
    error: true,
  },
  "error:addresses_full": {
    text: `You can save up to ${MAX_ADDRESSES} addresses. Delete one to add another.`,
    error: true,
  },
};

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { slug } = await params;
  const { saved, error } = await searchParams;
  const space = `/b/${encodeURIComponent(slug)}`;
  const { own, book, email } = await withCustomer(
    slug,
    `${space}/profile`,
    async (client, customer, session) => ({
      own: customer ? await customerContact(client, customer) : null,
      book: customer ? await addressBook(client, customer) : [],
      email: session.email,
    }),
  );
  const page = await publicPage(server().db, slug);
  if (!page) notFound();
  const message = MESSAGES[error ? `error:${error}` : `saved:${saved}`] ?? null;

  return (
    <>
      <BusinessHeader business={page} home={{ href: space }}>
        <h1>Your profile</h1>
      </BusinessHeader>
      <ProfileSheets
        own={own}
        email={email}
        book={book.map((entry) => ({
          id: entry.id,
          label: entry.label,
          contactName: entry.contactName,
          contactPhone: localPhone(entry.contactPhone),
          address: entry.address,
          latitude: entry.location?.latitude,
          longitude: entry.location?.longitude,
        }))}
        detailsAction={`${space}/profile/details`}
        addressAction={`${space}/profile/address`}
        placeAction={`${space}/request/place`}
        limits={{ address: MAX_ADDRESS, label: MAX_LABEL, addresses: MAX_ADDRESSES }}
        message={message}
      >
        <form className="actions" method="post" action={`${space}/signout`}>
          <button type="submit" className="quiet">
            Sign out
          </button>
        </form>
      </ProfileSheets>
      <CustomerNav space={space} current="profile" />
    </>
  );
}
