import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireMember } from "../../../guard.ts";
import { formatTime, formatWhen, STATUS_LABEL, statusTone } from "../../../job-labels.ts";
import { server } from "../../../server.ts";
import { MAX_WORK_PHOTOS, workSheet } from "../../../work.ts";
import { OwnerNav } from "../../owner-nav.tsx";
import { CheckIn, Checklist, Complete, FoundWork } from "./work-forms.tsx";

// The job sheet: what the person doing the work needs on site. The id in the path is only a lookup key: the job
// is read inside the member's own business and, for a technician, only on a work visit given to them
// (work.ts), so anyone else's job is a 404 like an unknown one.
const route = defineRoute({ scope: "member", roles: ["owner", "technician"] });

const PHOTO_ERROR: Record<string, string> = {
  none: "Choose a photo first.",
  kind: "Say whether the photos are from before or after the work.",
  too_many_in_one: "Add at most four photos at a time.",
  too_many_photos: `A job keeps at most ${MAX_WORK_PHOTOS} photos.`,
  photo_too_large: "That photo is too large. Try a smaller one.",
  photo_not_an_image: "That file is not a photo. Use a JPEG, PNG or WebP.",
  refused: "Photos can be added only while the work is under way.",
};

export default async function WorkSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ photo?: string }>;
}) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const member = await requireMember(route, `/work/${id.data}`);
  const { db, storage } = server();
  const sheet = await db.withTenant(member.businessId, (client) =>
    workSheet(client, member, id.data),
  );
  if (!sheet) notFound();
  const photoError = PHOTO_ERROR[(await searchParams).photo ?? ""];
  const underWay = sheet.status === "in_progress";
  const open = sheet.checklist.filter((item) => !item.done).length;
  const digits = sheet.contactPhone.replace(/\D/g, "");
  const back = member.role === "owner" ? `/jobs/${sheet.jobId}` : "/";
  return (
    <>
      <header className="bar">
        <h1>Job #{sheet.number}</h1>
        <a className="button quiet" href={back}>
          {member.role === "owner" ? "← Request" : "← My jobs"}
        </a>
      </header>
      <p className="muted small">
        <span className={`chip ${statusTone(sheet.status)}`}>{STATUS_LABEL[sheet.status]}</span>{" "}
        {formatWhen(sheet.startsAt)} to {formatTime(sheet.endsAt)} · {sheet.technicianName}
      </p>

      <div className="stack">
        <section className="panel" aria-label="Customer">
          <strong>{sheet.contactName}</strong>
          <span>{sheet.address ?? "No address given"}</span>
          <div className="actions">
            <a className="button quiet" href={`tel:${sheet.contactPhone}`}>
              Call
            </a>
            <a className="button quiet" href={`https://wa.me/${digits}`}>
              WhatsApp
            </a>
            {sheet.location ? (
              // The phone's own map app opens it; nothing is sent anywhere until the tap.
              <a
                className="button quiet"
                href={`https://www.google.com/maps/search/?api=1&query=${sheet.location.latitude},${sheet.location.longitude}`}
                rel="noreferrer"
                target="_blank"
              >
                Maps
              </a>
            ) : null}
          </div>
        </section>

        <section className="panel" aria-labelledby="work-title">
          <h2 id="work-title">The work</h2>
          <ul className="cards">
            {sheet.items.map((item) => (
              <li key={item.id} className="card">
                <strong>{item.title}</strong>
                {item.status === "requested" || item.status === "quoted" ? (
                  <span className="chip wait">Extra · not approved yet, do not start</span>
                ) : null}
                {item.details ? <span>{item.details}</span> : null}
                {item.photos.length > 0 ? (
                  <div className="photos">
                    {item.photos.map((photo) => (
                      // biome-ignore lint/performance/noImgElement: a presigned URL, not an asset Next can optimise
                      <img
                        key={photo.key}
                        src={storage.signedUrl(photo)}
                        alt="Sent with the request"
                        loading="lazy"
                      />
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {underWay ? <FoundWork jobId={sheet.jobId} /> : null}
        </section>

        {sheet.checklist.length > 0 ? (
          <section className="panel" aria-labelledby="checklist-title">
            <h2 id="checklist-title">
              Checklist{" "}
              <span className="count">
                {sheet.checklist.length - open}/{sheet.checklist.length}
              </span>
            </h2>
            <Checklist jobId={sheet.jobId} items={sheet.checklist} editable={underWay} />
            {sheet.status === "scheduled" ? (
              <p className="muted small">Tick the items once you have checked in.</p>
            ) : null}
          </section>
        ) : null}

        <section className="panel" aria-labelledby="photos-title">
          <h2 id="photos-title">
            Photos <span className="count">{sheet.photos.length}</span>
          </h2>
          {photoError ? (
            <p className="error" role="alert">
              {photoError}
            </p>
          ) : null}
          {(["before", "after"] as const).map((kind) => {
            const photos = sheet.photos.filter((p) => p.kind === kind);
            return photos.length > 0 ? (
              <div key={kind}>
                <span className="muted small">{kind === "before" ? "Before" : "After"}</span>
                <div className="photos">
                  {photos.map((photo) => (
                    // biome-ignore lint/performance/noImgElement: a presigned URL, not an asset Next can optimise
                    <img
                      key={photo.key}
                      src={storage.signedUrl(photo)}
                      alt={kind === "before" ? "Before the work" : "After the work"}
                      loading="lazy"
                    />
                  ))}
                </div>
              </div>
            ) : null;
          })}
          {underWay && sheet.photos.length < MAX_WORK_PHOTOS ? (
            <form
              method="post"
              action={`/work/${sheet.jobId}/photos`}
              encType="multipart/form-data"
              className="stack"
            >
              <div className="actions">
                <label className="choice">
                  <input type="radio" name="kind" value="before" defaultChecked={open > 0} />
                  Before
                </label>
                <label className="choice">
                  <input type="radio" name="kind" value="after" defaultChecked={open === 0} />
                  After
                </label>
              </div>
              <label>
                Photos (up to 4 at a time)
                <input type="file" name="photo" accept="image/*" multiple required />
              </label>
              <button type="submit" className="quiet">
                Add photos
              </button>
            </form>
          ) : sheet.photos.length === 0 ? (
            <p className="empty">
              {sheet.status === "scheduled"
                ? "Check in to add photos of the work."
                : "No photos were added."}
            </p>
          ) : null}
        </section>

        {sheet.completedAt ? (
          <section className="panel" aria-labelledby="done-title">
            <h2 id="done-title">Done</h2>
            <p role="status">
              Checked in {formatWhen(sheet.checkedInAt ?? sheet.completedAt)}, completed{" "}
              {formatWhen(sheet.completedAt)}.
            </p>
            {sheet.note ? <p className="muted">"{sheet.note}"</p> : null}
          </section>
        ) : sheet.checkedInAt ? (
          <p className="muted small">Checked in {formatWhen(sheet.checkedInAt)}.</p>
        ) : null}
      </div>

      {sheet.status === "scheduled" ? <CheckIn jobId={sheet.jobId} /> : null}
      {underWay ? <Complete jobId={sheet.jobId} open={open} /> : null}
      {member.role === "owner" ? <OwnerNav current="/jobs" /> : null}
    </>
  );
}
