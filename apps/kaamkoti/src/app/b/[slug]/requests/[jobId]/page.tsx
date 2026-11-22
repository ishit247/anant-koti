import { IMAGE_TYPES } from "@bodhchakra/storage";
import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { MAX_ADDRESS, MAX_ADDRESSES, MAX_LABEL } from "../../../../../address-book.ts";
import { withCustomer } from "../../../../../guard.ts";
import {
  MAX_ITEM_DETAILS,
  MAX_ITEM_TITLE,
  MAX_REQUEST_ITEMS,
  MAX_REQUEST_PHOTOS,
} from "../../../../../intake.ts";
import { CUSTOMER_STATUS_LABEL, formatWhen, statusTone } from "../../../../../job-labels.ts";
import { formatPrice } from "../../../../../price.ts";
import { publicPage } from "../../../../../public-page.ts";
import { customerRequest } from "../../../../../request-edit.ts";
import { server } from "../../../../../server.ts";
import { BusinessHeader } from "../../../../business-header.tsx";
import { CustomerNav } from "../../../../customer-nav.tsx";
import { RequestForm } from "../../request/request-form.tsx";

// One of the signed-in customer's own requests (D15): the new-request screens over its work items, until a quote
// is accepted. The form posts to ./edit (scope customer). Another customer's or business's id answers 404.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

const ERRORS = {
  locked: "A quote has been accepted, so the work items can no longer be changed here.",
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
  searchParams: Promise<{ result?: string; error?: string }>;
}) {
  const { slug, jobId } = await params;
  const { result, error } = await searchParams;
  const space = `/b/${encodeURIComponent(slug)}`;
  const job = await withCustomer(slug, `${space}/requests/${jobId}`, async (client, customer) =>
    customer ? customerRequest(client, customer, jobId) : null,
  );
  if (!job) notFound();
  const page = await publicPage(server().db, slug);
  if (!page) notFound();
  const done = result && result in RESULTS ? RESULTS[result as keyof typeof RESULTS] : null;
  const refused = error && error in ERRORS ? ERRORS[error as keyof typeof ERRORS] : null;

  return (
    <>
      <BusinessHeader business={page} home={{ href: `${space}/requests` }}>
        <h1>Request #{job.number}</h1>
        <p>
          <span className={`chip ${statusTone(job.status)}`}>
            {CUSTOMER_STATUS_LABEL[job.status]}
          </span>{" "}
          <span className="muted small">{formatWhen(job.createdAt)}</span>
        </p>
      </BusinessHeader>
      {done ? (
        <p className="notice" role="status">
          {done}
        </p>
      ) : null}
      {job.editable ? (
        <RequestForm
          // A saved edit shows the new items: the form's state starts from what the server sent.
          key={`${job.id}:${job.tasks.map((t) => t.id).join()}:${result ?? ""}`}
          own={null}
          book={[]}
          action={`${space}/requests/${job.id}/edit`}
          placeAction=""
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
            items: job.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              details: t.details ?? "",
              photos: t.photos,
            })),
            contact: job.contactName,
            address: job.address,
            quoted: job.status === "quoted",
          }}
        />
      ) : (
        <>
          <div className="panel">
            <p>
              <strong>{job.contactName}</strong>
            </p>
            <p className="muted">{job.address}</p>
          </div>
          <ul className="cards">
            {job.tasks.map((task) => (
              <li key={task.id} className="card">
                <strong>{task.title}</strong>
                {task.details ? <p className="muted small">{task.details}</p> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <CustomerNav space={space} current="requests" />
    </>
  );
}
