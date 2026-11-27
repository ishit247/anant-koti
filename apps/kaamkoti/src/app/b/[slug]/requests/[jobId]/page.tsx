import { IMAGE_TYPES } from "@bodhchakra/storage";
import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { addressBook, MAX_ADDRESS, MAX_ADDRESSES, MAX_LABEL } from "../../../../../address-book.ts";
import { customerContact } from "../../../../../customer-space.ts";
import { depositPayable, jobDeposit } from "../../../../../deposit.ts";
import { withCustomer } from "../../../../../guard.ts";
import {
  MAX_ITEM_DETAILS,
  MAX_ITEM_TITLE,
  MAX_REQUEST_ITEMS,
  MAX_REQUEST_PHOTOS,
} from "../../../../../intake.ts";
import { CUSTOMER_STATUS_LABEL, formatWhen, statusTone } from "../../../../../job-labels.ts";
import { localPhone } from "../../../../../phone.ts";
import { formatPrice } from "../../../../../price.ts";
import { publicPage } from "../../../../../public-page.ts";
import { customerRequest } from "../../../../../request-edit.ts";
import { server } from "../../../../../server.ts";
import { BusinessHeader } from "../../../../business-header.tsx";
import { CustomerNav } from "../../../../customer-nav.tsx";
import { WorkItems } from "../../../../work-items.tsx";
import { RequestForm } from "../../request/request-form.tsx";
import { DepositPay } from "./deposit-pay.tsx";
import { QuoteAnswer } from "./quote-answer.tsx";
import { VisitAnswer } from "./visit-answer.tsx";

// One of the signed-in customer's own requests (D15): the work's time once proposed (posting to ./visit), the
// quote with its answer forms (posting to ./answer), the deposit once accepted (posting to ./pay), and
// the new-request screens over its work items until a quote is accepted (posting to ./edit); after that, the
// items with their photos. Another customer's or business's id answers 404.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

const ERRORS = {
  locked: "A quote has been accepted, so the work items can no longer be changed here.",
  contact: "Please check the name, a 10-digit mobile number, the address and what to save it as.",
  location: "Your location could not be read. Please try again, or leave it out.",
  address: "That address is no longer in your address book. Please choose again.",
  addresses_full: `Your address book is full (${MAX_ADDRESSES}). Untick "Save for next time", or delete one on your profile.`,
  items: "Please keep at least one work item, each with a title.",
  too_many_photos: `Please keep at most ${MAX_REQUEST_PHOTOS} photos in all.`,
  photo_too_large: "A photo is larger than 10 MB. Please send a smaller one.",
  photo_not_an_image: "Photos must be JPEG, PNG or WebP images.",
} as const;

const RESULTS = {
  saved: "Your changes are saved.",
  unchanged: "Nothing changed, so your quote stays as it was.",
} as const;

export default async function RequestDetail({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; jobId: string }>;
  searchParams: Promise<{
    result?: string;
    error?: string;
    answer?: string | string[];
    visit?: string | string[];
    pay?: string | string[];
  }>;
}) {
  const { slug, jobId } = await params;
  const { result, error, answer, visit, pay } = await searchParams;
  const space = `/b/${encodeURIComponent(slug)}`;
  const { db, storage, payments } = server();
  const { job, own, book, deposit } = await withCustomer(
    slug,
    `${space}/requests/${jobId}`,
    async (client, customer) => {
      const job = customer ? await customerRequest(client, customer, jobId) : null;
      if (!customer || !job) return { job: null, own: null, book: [], deposit: null };
      return {
        job,
        own: await customerContact(client, customer),
        book: await addressBook(client, customer),
        // Only after the job was found under this customer.
        deposit: await jobDeposit(client, payments, customer.businessId, job.id),
      };
    },
  );
  if (!job) notFound();
  const page = await publicPage(db, slug);
  if (!page) notFound();
  const done = result && result in RESULTS ? RESULTS[result as keyof typeof RESULTS] : null;
  const refused = error && error in ERRORS ? ERRORS[error as keyof typeof ERRORS] : null;

  return (
    <>
      <BusinessHeader business={page} home={{ href: `${space}/requests` }}>
        <h1>
          Request #{job.number}{" "}
          <span className={`chip ${statusTone(job.status)}`}>
            {CUSTOMER_STATUS_LABEL[job.status]}
          </span>{" "}
          <span className="muted small">{formatWhen(job.createdAt)}</span>
        </h1>
      </BusinessHeader>
      {done ? (
        <p className="notice" role="status">
          {done}
        </p>
      ) : null}
      {job.workTime ? (
        <VisitAnswer
          work={job.workTime}
          status={job.status}
          businessName={page.name}
          action={`${space}/requests/${job.id}/visit`}
          said={typeof visit === "string" ? visit : undefined}
        />
      ) : null}
      {job.quote ? (
        <QuoteAnswer
          quote={job.quote}
          status={job.status}
          businessName={page.name}
          action={`${space}/requests/${job.id}/answer`}
          said={typeof answer === "string" ? answer : undefined}
        />
      ) : null}
      {deposit && (depositPayable(job.status) || deposit.paid.minor > 0) ? (
        <DepositPay
          deposit={deposit}
          payable={depositPayable(job.status)}
          businessName={page.name}
          action={`${space}/requests/${job.id}/pay`}
          said={typeof pay === "string" ? pay : undefined}
        />
      ) : null}
      {job.editable ? (
        <RequestForm
          // A saved edit shows the new items: the form's state starts from what the server sent.
          key={`${job.id}:${job.items.map((t) => t.id).join()}:${result ?? ""}`}
          own={own}
          book={book.map((entry) => ({
            id: entry.id,
            label: entry.label,
            contactName: entry.contactName,
            contactPhone: localPhone(entry.contactPhone),
            address: entry.address,
          }))}
          action={`${space}/requests/${job.id}/edit`}
          placeAction={`${space}/request/place`}
          services={page.services.map((s) => ({
            name: s.name,
            price: formatPrice(s.price, s.unit),
          }))}
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
          errors={ERRORS}
          refused={refused}
          edit={{
            items: job.items.map((t) => ({
              id: t.id,
              title: t.title,
              details: t.details ?? "",
              photos: t.photos.length,
            })),
            place: {
              contactName: job.place.contactName,
              contactPhone: localPhone(job.place.contactPhone),
              address: job.place.address,
              latitude: job.place.location?.latitude,
              longitude: job.place.location?.longitude,
            },
            // The saved address this request went to, if it is still in the book, starts selected.
            savedId:
              book.find(
                (entry) =>
                  entry.address === job.place.address &&
                  entry.contactName === job.place.contactName &&
                  entry.contactPhone === job.place.contactPhone,
              )?.id ?? "",
            quoted: job.status === "quoted",
          }}
        />
      ) : (
        <div className="stack">
          <section className="panel" aria-labelledby="where-title">
            <h2 id="where-title">Where</h2>
            <p>
              <strong>{job.place.contactName}</strong>
              <br />
              <span className="muted">{job.place.address}</span>
            </p>
          </section>
          <section className="panel" aria-labelledby="work-title">
            <h2 id="work-title">
              Work needed
              <span className="count">{job.items.length}</span>
            </h2>
            {/* Signed after the job was found under this customer: each URL opens one object for five minutes. */}
            <WorkItems
              items={job.items}
              sign={(photo) => storage.signedUrl(photo)}
              photoAlt="Sent with your request"
            />
          </section>
        </div>
      )}
      <CustomerNav space={space} current="requests" />
    </>
  );
}
