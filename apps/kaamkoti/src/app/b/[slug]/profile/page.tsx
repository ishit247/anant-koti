import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { customerContact } from "../../../../customer-space.ts";
import { withCustomer } from "../../../../guard.ts";
import { publicPage } from "../../../../public-page.ts";
import { server } from "../../../../server.ts";
import { BusinessHeader } from "../../../business-header.tsx";
import { CustomerNav } from "../../../customer-nav.tsx";

// The signed-in customer's own details with this business (D15), and the one way to sign out.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

export default async function ProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const space = `/b/${encodeURIComponent(slug)}`;
  const { contact, email } = await withCustomer(
    slug,
    `${space}/profile`,
    async (client, customer, session) => ({
      contact: customer ? await customerContact(client, customer) : null,
      email: session.email,
    }),
  );
  const page = await publicPage(server().db, slug);
  if (!page) notFound();

  return (
    <>
      <BusinessHeader business={page} home={{ href: space }}>
        <h1>Your profile</h1>
      </BusinessHeader>
      <section className="panel">
        <dl className="facts">
          {contact ? (
            <>
              <div>
                <dt>Name</dt>
                <dd>{contact.name}</dd>
              </div>
              <div>
                <dt>Mobile</dt>
                <dd>{contact.phone}</dd>
              </div>
              {contact.address ? (
                <div>
                  <dt>Address</dt>
                  <dd>{contact.address}</dd>
                </div>
              ) : null}
            </>
          ) : null}
          <div>
            <dt>Email</dt>
            <dd>{email}</dd>
          </div>
        </dl>
        {contact ? null : (
          <p className="muted small">
            Your name, mobile and address are saved with your first request to {page.name}.
          </p>
        )}
      </section>
      <form className="actions" method="post" action={`${space}/signout`}>
        <button type="submit" className="quiet">
          Sign out
        </button>
      </form>
      <CustomerNav space={space} current="profile" />
    </>
  );
}
