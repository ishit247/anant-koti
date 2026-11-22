// Phase-end browser check: `pnpm run check:browser`, against the running dev stack (`pnpm run up:fresh`,
// the platform container, `pnpm --filter kaamkoti dev`). Chromium lives on D: (set
// PLAYWRIGHT_BROWSERS_PATH=D:\playwright-browsers; install with `pnpm exec playwright install chromium-headless-shell`). A new owner signs in with an email code read from
// Mailpit, creates a business, picks a trade, edits a price, and the public page and a customer's job link are
// opened without cookies. A new customer signs in on the bare domain to send a request with a photo, lands on
// their work list, and finds the form filled in next time; the send route refuses another origin and sends a
// post without a session to sign-in. A seeded customer signs in on the bare domain and sees only her own
// request; intake and /j/ answer 429 past their per-IP limits.
// Each page is screenshotted at phone and desktop width into .validation/browser/; the run fails on a console
// error, a page wider than the viewport, or a cookie on the public page.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page } from "playwright";

const APP = "http://127.0.0.1:45450";
/** The same dev server as the bare domain (PUBLIC_ORIGIN): customers' host. */
const PUBLIC = "http://localhost:45450";
const MAILPIT = "http://127.0.0.1:45446";
const OUT = fileURLToPath(new URL("../.validation/browser/", import.meta.url));
const WIDTHS = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1280, height: 900 },
} as const;

const run = Date.now().toString(36);
const email = `owner-${run}@example.test`;
const businessName = `Check Cooling ${run}`;
const slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const problems: string[] = [];
/** A valid 1×1 PNG, the photo the customer sends. */
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** The newest sign-in code sent to `to`, from Mailpit. */
async function signInCode(to = email): Promise<string> {
  for (let tries = 0; tries < 50; tries++) {
    const found = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    if (!found.ok) throw new Error(`mailpit search failed: ${found.status}`);
    const { messages } = (await found.json()) as { messages: { Subject: string }[] };
    const code = messages[0]?.Subject.match(/^(\d{6}) /)?.[1];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no sign-in code arrived for ${to}`);
}

/** The platform sign-in page: the email and "Get code", then the code and "Sign in". */
async function signInAs(page: Page, address: string, shotName?: string) {
  await page.waitForURL(/\/sign-in/);
  if (shotName) await shoot(page, shotName);
  // Codes are searched newest first, so one left from an earlier run must not be read as this one.
  await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`, {
    method: "DELETE",
  });
  await page.fill("input[name=email]", address);
  await page.getByRole("button", { name: "Get code" }).click();
  await page.locator("input[name=code]").waitFor({ state: "visible" });
  if (shotName) await shoot(page, `${shotName}-code`);
  await page.fill("input[name=code]", await signInCode(address));
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Screenshots the current page at both widths and records horizontal overflow. */
async function shoot(page: Page, name: string) {
  for (const [label, size] of Object.entries(WIDTHS)) {
    await page.setViewportSize(size);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) problems.push(`${name} at ${label}: ${overflow}px wider than the viewport`);
    await page.screenshot({ path: `${OUT}${name}-${label}.png`, fullPage: true });
  }
  await page.setViewportSize(WIDTHS.phone);
}

function watchConsole(page: Page, context: string) {
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`${context}: console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`${context}: page error: ${e.message}`));
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let owner: BrowserContext | undefined;
try {
  owner = await browser.newContext({ viewport: WIDTHS.phone });
  const page = await owner.newPage();
  watchConsole(page, "owner");

  await page.goto(`${APP}/`);
  await shoot(page, "1-home-signed-out");
  await page.getByRole("link", { name: "Start free" }).click();
  await signInAs(page, email, "2-sign-in");

  await page.waitForURL(`${APP}/signup`);
  await shoot(page, "3-signup");
  await page.fill("input[name=yourName]", "Asha Verma");
  await page.fill("input[name=businessName]", businessName);
  await page.fill("input[name=city]", "Pune");
  await page.fill("input[name=phone]", "+91 98765 43210");
  await page.getByRole("button", { name: "Create my business" }).click();

  await page.waitForURL(`${APP}/onboarding`);
  await shoot(page, "4-onboarding");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.waitForURL(`${APP}/catalogue`);
  await shoot(page, "5-catalogue");
  await page.locator("input[name=price]").first().fill("555");
  await page.getByRole("button", { name: "Save prices" }).click();
  await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
  await shoot(page, "6-catalogue-saved");

  await page.goto(`${APP}/`);
  await shoot(page, "7-home-owner");

  // The owner's inbox: log a phone enquiry, open it, and send the customer a fresh link.
  const tabs = page.getByRole("navigation", { name: "Main" });
  await tabs.getByRole("link", { name: "Requests" }).click();
  await page.waitForURL(`${APP}/jobs`);
  await shoot(page, "7a-inbox-empty");
  await page.getByRole("link", { name: "+ Phone enquiry" }).click();
  await page.waitForURL(`${APP}/jobs/new`);
  await page.fill("input[name=name]", "Phone Caller");
  await page.fill("input[name=phone]", "98220 11122");
  await page.fill("textarea[name=address]", "3 Call Lane, Pune");
  await page.getByRole("button", { name: "Save request" }).click();
  await page.getByRole("alert").filter({ hasText: "at least one service" }).waitFor();
  await shoot(page, "7b-enquiry-refused");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Save request" }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
  if (!(await page.getByRole("heading", { name: "Request #1" }).count()))
    problems.push("a logged enquiry does not open as request #1");
  await shoot(page, "7c-job-detail");
  await page.getByRole("button", { name: "Revoke old links, send a new one" }).click();
  const fresh = await page.getByLabel("Customer link").inputValue();
  const stranger = await browser.newContext({ viewport: WIDTHS.phone });
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(fresh);
  if (!(await strangerPage.getByRole("heading", { name: "Request #1" }).count()))
    problems.push("the re-sent customer link does not open the request");
  await stranger.close();
  await shoot(page, "7d-link-resent");

  // A quote: the first draft prices the request's task from the price list; add a discount line, have a deposit
  // above the total refused without losing the lines, send, and read it through the customer's new link.
  const jobUrl = page.url();
  await page.getByRole("button", { name: "Write a quote" }).click();
  await page.waitForURL(/\/quote$/);
  await shoot(page, "7d1-quote-draft");
  await page.getByRole("button", { name: "Custom line" }).click();
  await page.locator("input[name=description]").last().fill("Discount");
  await page.locator("input[name=price]").last().fill("-55");
  await page.fill("input[name=deposit]", "999999");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("alert").filter({ hasText: "deposit cannot be more" }).waitFor();
  if ((await page.locator("input[name=description]").count()) !== 2)
    problems.push("a refused quote save lost a line");
  await shoot(page, "7d2-quote-refused");
  await page.fill("input[name=deposit]", "");
  await page.getByRole("button", { name: "Send quote" }).click();
  await page.getByRole("status").filter({ hasText: "is sent" }).waitFor();
  const quoteLink = await page.getByLabel("Customer link").inputValue();
  await shoot(page, "7d3-quote-sent");
  const reader = await browser.newContext({ viewport: WIDTHS.phone });
  const readerPage = await reader.newPage();
  watchConsole(readerPage, "customer quote");
  await readerPage.goto(quoteLink);
  if (!(await readerPage.getByRole("heading", { name: "Your quote" }).count()))
    problems.push("the customer's link does not show the sent quote");
  if (!(await readerPage.getByText("Discount").count()))
    problems.push("the customer's quote lacks the discount line");
  await shoot(readerPage, "7d4-customer-quote");
  if ((await reader.cookies()).length > 0) problems.push("customer quote context holds cookies");

  // Negotiation: the customer offers a lower price; the owner sees it and revises; the customer accepts the
  // new version, after which the owner is offered no revision.
  await readerPage.getByText("Offer a different price").click();
  await readerPage.fill("input[name=total]", "400");
  await readerPage.fill("textarea[name=note]", "Can you do it for 400?");
  await readerPage.getByRole("button", { name: "Send my price" }).click();
  await readerPage.getByRole("status").filter({ hasText: "Your price is sent" }).waitFor();
  if (await readerPage.getByRole("button", { name: /Accept quote/ }).count())
    problems.push("a countered quote still offers acceptance");
  await shoot(readerPage, "7d5-customer-countered");
  if ((await reader.cookies()).length > 0) problems.push("customer counter context holds cookies");
  await reader.close();
  await page.goto(jobUrl);
  if (!(await page.getByText("offered ₹400.00").count()))
    problems.push("the owner does not see the counter-offer");
  await shoot(page, "7d6-job-countered");
  await page.getByRole("button", { name: "Revise the quote" }).click();
  await page.waitForURL(/\/quote$/);
  await page.getByRole("button", { name: "Send quote" }).click();
  await page.getByRole("status").filter({ hasText: "is sent" }).waitFor();
  const revisedLink = await page.getByLabel("Customer link").inputValue();
  const accepter = await browser.newContext({ viewport: WIDTHS.phone });
  const accepterPage = await accepter.newPage();
  watchConsole(accepterPage, "customer accept");
  await accepterPage.goto(revisedLink);
  await accepterPage.getByRole("button", { name: /Accept quote/ }).click();
  await accepterPage.getByRole("status").filter({ hasText: "has your acceptance" }).waitFor();
  await shoot(accepterPage, "7d7-customer-accepted");
  if ((await accepter.cookies()).length > 0) problems.push("customer accept context holds cookies");
  await accepter.close();
  await page.goto(jobUrl);
  if (!(await page.getByText("accepted this quote").count()))
    problems.push("the owner does not see the acceptance");
  if (await page.getByRole("button", { name: "Revise the quote" }).count())
    problems.push("an accepted quote still offers a revision");
  await shoot(page, "7d8-job-accepted");
  await tabs.getByRole("link", { name: "Requests" }).click();
  await page.waitForURL(`${APP}/jobs`);
  if (!(await page.getByText("Phone Caller").count()))
    problems.push("the logged enquiry is missing from the inbox");
  await shoot(page, "7e-inbox");
  await page.goto(`${APP}/`);
  await shoot(page, "7f-home-with-requests");

  // The public page in a context that has never held a cookie.
  const visitor = await browser.newContext({ viewport: WIDTHS.phone });
  const publicPage = await visitor.newPage();
  watchConsole(publicPage, "public");
  const response = await publicPage.goto(`${APP}/b/${slug}`);
  if (response?.status() !== 200) problems.push(`public page answered ${response?.status()}`);
  if (response?.headers()["set-cookie"]) problems.push("public page set a cookie");
  if (!(await publicPage.getByText("₹555.00").count()))
    problems.push("public page lacks the edited price");
  await shoot(publicPage, "8-public-page");
  if ((await visitor.cookies()).length > 0) problems.push("visitor context holds cookies");
  // fetch, not the page: the browser logs a 404 as a console error.
  const missing = await fetch(`${APP}/b/no-such-business-${run}`);
  if (missing.status !== 404) problems.push(`unknown slug answered ${missing.status}`);

  // The customer's job link (seeded in apps/kaamkoti/seed.sql), also cookieless.
  const jobPage = await visitor.newPage();
  watchConsole(jobPage, "job link");
  const job = await jobPage.goto(`${APP}/j/dev-job-link-sharma-request-1-xxxxxxxxxxxxx`);
  if (job?.status() !== 200) problems.push(`job link answered ${job?.status()}`);
  if (job?.headers()["set-cookie"]) problems.push("job link set a cookie");
  if (job?.headers()["referrer-policy"] !== "no-referrer")
    problems.push("job link lacks Referrer-Policy: no-referrer");
  if (!(await jobPage.getByRole("heading", { name: "Request #1" }).count()))
    problems.push("job link does not show request #1");
  await shoot(jobPage, "9-job-link");
  await jobPage.goto(`${APP}/j/${"x".repeat(43)}`);
  if (!(await jobPage.getByText("This link is no longer valid").count()))
    problems.push("an unknown job link is not refused");
  await shoot(jobPage, "10-job-link-dead");
  if ((await visitor.cookies()).length > 0) problems.push("visitor context holds cookies");
  await visitor.close();

  // A new customer's request (D15): "New work" asks them to sign in on the bare domain first, by email code,
  // and comes back to the form. Its own address, so runs never share counters; its own mobile, because a
  // number on another customer's record is refused.
  const customer = await browser.newContext({
    viewport: WIDTHS.phone,
    extraHTTPHeaders: { "x-client-ip": `browser-${run}` },
  });
  const form = await customer.newPage();
  watchConsole(form, "request form");
  await form.goto(`${APP}/b/sharma-cooling`);
  await form.getByRole("link", { name: "New work" }).click();
  await signInAs(form, `customer-${run}@example.test`);
  await form.waitForURL(`${PUBLIC}/b/sharma-cooling/request`);
  await shoot(form, "11-request-form");
  if (await form.inputValue("input[name=name]"))
    problems.push("a first-time customer's form is filled in from someone else's record");
  await form.fill("input[name=name]", "Browser Check");
  await form.fill("input[name=phone]", `9${String(Date.now()).slice(-9)}`);
  await form.fill("textarea[name=address]", "1 Check Road, Pune");
  // No work item yet: the form says so without posting.
  await form.getByRole("button", { name: "Send request" }).click();
  if (!(await form.getByRole("alert").filter({ hasText: "at least one work item" }).count()))
    problems.push("a request without a work item is not explained");
  await shoot(form, "12-request-form-error");
  // Saved items keep their (hidden) fields in the form; labels are looked up in the open editor only.
  const editor = () => form.locator(".sheet:not([hidden])");
  // A price-list item with a photo: the editor shows its price.
  await form.getByRole("button", { name: "Add work item" }).click();
  await editor().getByLabel("What needs doing?").fill("AC gas refill");
  if (!(await form.getByText("from the price list").count()))
    problems.push("a price-list title does not show its price");
  await editor().getByLabel("Details (optional)").fill("Bedroom split AC, not cooling.");
  await editor()
    .getByLabel("Photos (optional)")
    .setInputFiles({
      name: "ac.png",
      mimeType: "image/png",
      buffer: Buffer.from(ONE_PIXEL_PNG, "base64"),
    });
  await shoot(form, "12a-work-item-editor");
  await form.getByRole("button", { name: "Save" }).click();
  // The customer's own words: priced by the business.
  await form.getByRole("button", { name: "Add work item" }).click();
  await editor().getByLabel("What needs doing?").fill("Broken wire");
  if (!(await form.getByText("The business will quote a price").count()))
    problems.push("a title of the customer's own does not say it will be quoted");
  await form.getByRole("button", { name: "Save" }).click();
  // Back on a new item discards it.
  await form.getByRole("button", { name: "Add work item" }).click();
  await editor().getByLabel("What needs doing?").fill("Changed my mind");
  await form.getByRole("button", { name: "Back" }).click();
  if (await form.getByText("Changed my mind").count())
    problems.push("Back on a new work item does not discard it");
  await shoot(form, "12b-request-with-items");
  await form.getByRole("button", { name: "Send request" }).click();
  // The request lands in their work list. Its details and photo are checked on the customer's job page once
  // that exists (3.2f, second half); intake.test.ts checks the photo by signed URL meanwhile.
  await form.waitForURL(`${PUBLIC}/b/sharma-cooling/requests`);
  const sent = await form.locator(".cards > li").allTextContents();
  if (sent.length !== 1 || !sent[0]?.includes("AC gas refill"))
    problems.push(`the new customer's work list shows ${JSON.stringify(sent)}`);
  await shoot(form, "13-request-sent");
  // Asked again, the form is filled in from their record.
  await form.goto(`${PUBLIC}/b/sharma-cooling/request`);
  if ((await form.inputValue("input[name=name]")) !== "Browser Check")
    problems.push("a returning customer's form is not filled in from their record");

  // The send and sign-out routes' own guards, with and without the session. fetch and the context's request
  // API send neither a browser Origin nor Sec-Fetch-Site, so each sets what it tests: a browser's cross-site
  // post (Sec-Fetch-Site wins even over a right Origin), and an old browser's foreign Origin.
  const sendTo = (s: string) => `${PUBLIC}/b/${s}/request/send`;
  for (const [what, headers] of [
    ["cross-site", { "sec-fetch-site": "cross-site", origin: PUBLIC }],
    ["foreign-origin", { origin: "https://evil.example" }],
  ] as const)
    for (const url of [sendTo("sharma-cooling"), `${PUBLIC}/b/sharma-cooling/signout`]) {
      const status = (
        await customer.request.post(url, { headers, multipart: {}, maxRedirects: 0 })
      ).status();
      if (status !== 403) problems.push(`a ${what} post to ${url} answered ${status}`);
    }
  const anonymous = await fetch(sendTo("sharma-cooling"), {
    method: "POST",
    redirect: "manual",
    headers: { origin: PUBLIC },
    body: new FormData(),
  });
  if (
    anonymous.status !== 303 ||
    !anonymous.headers.get("location")?.startsWith("/b/sharma-cooling/login?")
  )
    problems.push(`a request post without a session answered ${anonymous.status}, not sign-in`);
  // Past the limit, signed in. Intake counts before it looks at the slug, so an unknown one keeps real
  // counters clean.
  let intake = 0;
  for (let i = 0; i < 11; i++)
    intake = (
      await customer.request.post(sendTo(`limit-check-${run}`), {
        headers: { origin: PUBLIC, "x-client-ip": `limit-${run}` },
        multipart: {},
        maxRedirects: 0,
      })
    ).status();
  if (intake !== 429) problems.push(`intake past its limit answered ${intake}`);
  await customer.close();

  // A signed-in customer (D15): seeded Anita opens "My requests" on the bare domain, signs in there, and sees
  // only her request with Sharma. Her cookie is the customer one, on the bare domain only, and the app host
  // does not take her as a member.
  const anita = await browser.newContext({ viewport: WIDTHS.phone });
  const space = await anita.newPage();
  watchConsole(space, "customer space");
  await space.goto(`${APP}/b/sharma-cooling`);
  await space.getByRole("link", { name: "Work list" }).click();
  await signInAs(space, "anita@example.com", "14-customer-sign-in");
  await space.waitForURL(`${PUBLIC}/b/sharma-cooling/requests`);
  await shoot(space, "15-customer-home");
  const jobs = await space.locator(".cards > li").allTextContents();
  if (jobs.length !== 1 || !jobs[0]?.includes("#1"))
    problems.push(`the customer home lists ${JSON.stringify(jobs)}, not Anita's request #1 only`);
  await space.getByRole("link", { name: "Cancelled" }).click();
  await space.waitForURL(`${PUBLIC}/b/sharma-cooling/requests?status=cancelled`);
  await shoot(space, "16-customer-home-empty");
  const cookies = await anita.cookies();
  const wrong = cookies.filter(
    (c) => c.name === "__Host-kk_session" || new URL(PUBLIC).hostname !== c.domain,
  );
  if (!cookies.some((c) => c.name === "__Host-kk_customer"))
    problems.push("no customer cookie after the customer signed in");
  // Platform's own session cookie lives on its host; only Kaam Koti's are checked here.
  if (wrong.some((c) => c.name.startsWith("__Host-kk_")))
    problems.push(`customer cookies outside the bare domain: ${wrong.map((c) => c.name)}`);
  // On the app host her customer session counts for nothing: she signs in afresh (platform remembers her, so
  // this can be instant) as an identity with no business, which goes to signup, never to the jobs.
  await space.goto(`${APP}/jobs`);
  if (new URL(space.url()).pathname === "/jobs")
    problems.push(`a customer opened the members' app at ${space.url()}`);
  // The way out is on her profile, reached from the tab bar, which shows her own record with Sharma.
  await space.goto(`${PUBLIC}/b/sharma-cooling/requests`);
  await space.getByRole("link", { name: "Profile" }).click();
  await space.waitForURL(`${PUBLIC}/b/sharma-cooling/profile`);
  await shoot(space, "16b-customer-profile");
  const profile = await space.locator("dl.facts").textContent();
  if (!profile?.includes("anita@example.com") || !profile.includes("Anita"))
    problems.push(`the customer profile shows ${JSON.stringify(profile)}, not Anita's record`);
  if ((await space.getByRole("button", { name: "Sign out" }).count()) !== 1)
    problems.push("the customer profile has no single Sign out button");
  await space.getByRole("button", { name: "Sign out" }).click();
  await space.waitForURL(`${PUBLIC}/b/sharma-cooling`);
  if ((await anita.cookies()).some((c) => c.name === "__Host-kk_customer"))
    problems.push("the customer cookie survived sign-out");
  await anita.close();

  // Past the /j/ lookup limit.
  let lookups = 0;
  for (let i = 0; i < 61; i++)
    lookups = (
      await fetch(`${APP}/j/${"y".repeat(43)}`, {
        redirect: "manual",
        headers: { "x-client-ip": `limit-${run}` },
      })
    ).status;
  if (lookups !== 429) problems.push(`job link lookups past their limit answered ${lookups}`);
} finally {
  await owner?.close();
  await browser.close();
}

console.log(`screenshots in ${OUT}`);
if (problems.length > 0) {
  console.error(`browser check failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("browser check passed");
