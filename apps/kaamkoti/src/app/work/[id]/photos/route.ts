import { type CheckedImage, checkImage, MAX_IMAGE_BYTES } from "@bodhchakra/storage";
import { defineRoute, NotPermittedError, requireRole } from "@bodhchakra/tenancy";
import { z } from "zod";
import { server } from "../../../../server.ts";
import { addWorkPhotos, WORK_PHOTO_KINDS } from "../../../../work.ts";

// The member's photos of the work, before or after it. The job is found inside the member's own business and,
// for a technician, only on a work visit given to them (work.ts); anything else is a 404. A route handler rather
// than a server action, for the same reason as the request form: photos exceed a server action's body limit.
const route = defineRoute({ scope: "member", roles: ["owner", "technician"] });

/** Photos in one post; the job's own limit (MAX_WORK_PHOTOS) is checked in work.ts. */
const PER_POST = 4;
const MAX_BODY_BYTES = PER_POST * MAX_IMAGE_BYTES + 1024 * 1024;

const seeOther = (location: string) => new Response(null, { status: 303, headers: { location } });
const notFound = () => new Response("Not found.\n", { status: 404 });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return notFound();
  const { auth, db, storage, origin } = server();
  // The cookie is SameSite=Lax already; this refuses another site's post outright.
  const site = request.headers.get("sec-fetch-site");
  if (site ? site !== "same-origin" : request.headers.get("origin") !== origin)
    return new Response(null, { status: 403 });
  const sheet = `/work/${id.data}`;
  const session = await auth.getSession(request.headers.get("cookie"));
  if (!session) return seeOther(`/login?return=${encodeURIComponent(sheet)}`);
  const member = session.memberships[0];
  if (!member) return notFound();
  try {
    requireRole(member, ...route.roles);
  } catch (error) {
    if (error instanceof NotPermittedError) return notFound();
    throw error;
  }

  const length = Number(request.headers.get("content-length"));
  if (!(length > 0 && length <= MAX_BODY_BYTES)) return seeOther(`${sheet}?photo=too_many_in_one`);
  let body: FormData;
  try {
    body = await request.formData();
  } catch {
    // Documented fallback: a body that is not a form is the sender's mistake, answered as such.
    return new Response("Expected a form.\n", { status: 400 });
  }
  const kind = z.enum(WORK_PHOTO_KINDS).safeParse(body.get("kind"));
  if (!kind.success) return seeOther(`${sheet}?photo=kind`);
  const files = body.getAll("photo").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return seeOther(`${sheet}?photo=none`);
  if (files.length > PER_POST) return seeOther(`${sheet}?photo=too_many_in_one`);
  // Decoded and checked before a connection is taken: decoding is the slow part.
  const images: CheckedImage[] = [];
  for (const file of files) {
    const checked = await checkImage(new Uint8Array(await file.arrayBuffer()));
    if (!checked.ok)
      return seeOther(
        `${sheet}?photo=${checked.reason === "too_large" ? "photo_too_large" : "photo_not_an_image"}`,
      );
    images.push(checked.image);
  }
  const result = await db.withTenant(member.businessId, (client) =>
    addWorkPhotos(client, storage, member, id.data, kind.data, images),
  );
  if (result.ok) return seeOther(sheet);
  if (result.error === "not_found") return notFound();
  return seeOther(`${sheet}?photo=${result.error}`);
}
