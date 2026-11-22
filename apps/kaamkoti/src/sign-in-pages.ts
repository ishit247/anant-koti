// Plain pages for the two ways sign-in can fail outside a React tree (route handlers answer with a Response).
// `retry` starts sign-in again; a customer's callback does not know the business, so it offers no link.
const page = (status: number, title: string, body: string, retry: string | null) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p>${retry ? `<p><a href="${retry}">Try again</a></p>` : ""}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** The response did not belong to a sign-in this browser started. */
export const refused = (retry: string | null = "/login") =>
  page(
    400,
    "Sign-in did not complete",
    retry
      ? "That sign-in link is used up or expired."
      : "That sign-in link is used up or expired. Open the business's page and sign in again.",
    retry,
  );

/** Platform is down or slow; people already signed in are not affected. */
export const unavailable = (retry: string | null = "/login") =>
  page(503, "Sign-in is briefly unavailable", "Please try again in a minute.", retry);
