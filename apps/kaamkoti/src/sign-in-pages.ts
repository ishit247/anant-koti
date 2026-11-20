// Plain pages for the two ways sign-in can fail outside a React tree (route handlers answer with a Response).
const page = (status: number, title: string, body: string) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p><p><a href="/login">Try again</a></p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** The response did not belong to a sign-in this browser started. */
export const refused = () =>
  page(400, "Sign-in did not complete", "That sign-in link is used up or expired.");

/** Platform is down or slow; people already signed in are not affected. */
export const unavailable = () =>
  page(503, "Sign-in is briefly unavailable", "Please try again in a minute.");
