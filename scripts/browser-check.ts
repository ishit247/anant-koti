// Phase-end browser check: `pnpm run check:browser`, against the running dev stack (`pnpm run up:fresh`,
// the platform container, `pnpm --filter kaamkoti dev` and `pnpm --filter kaamkoti dev:worker`, which carries
// the notices whose emails are looked for in Mailpit). Chromium lives on D: (set
// PLAYWRIGHT_BROWSERS_PATH=D:\playwright-browsers; install with `pnpm exec playwright install chromium-headless-shell`). A new owner signs in with an email code read from
// Mailpit, creates a business, picks a trade, edits a price, and the public page is opened without cookies. A
// new customer signs in on the bare domain to send a request with a photo, lands on their work list, and finds
// the form filled in next time; the send route refuses another origin and sends a post without a session to
// sign-in. She then asks the new business for work, and the quote is negotiated and accepted on her request
// page, which refuses another site's post and answers 404 for another customer's or business's job. A seeded
// customer signs in on the bare domain and sees only her own request; intake answers 429 past its per-IP limit.
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
const customerEmail = `customer-${run}@example.test`;
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

/**
 * Records a problem unless an email to `to` whose subject matches arrives: the whole path of a notice, from the
 * app's outbox through its worker and platform to SMTP (3.2b).
 */
async function expectMail(to: string, subject: RegExp, what: string): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    const found = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    if (!found.ok) throw new Error(`mailpit search failed: ${found.status}`);
    const { messages } = (await found.json()) as { messages: { Subject: string }[] };
    if (messages.some((message) => subject.test(message.Subject))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  problems.push(`no email for ${what} arrived (is the worker running?)`);
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
    // caret "initial": hiding the caret styles inputs, which React reports as a hydration mismatch when a
    // screenshot lands before hydration ends.
    await page.screenshot({ path: `${OUT}${name}-${label}.png`, fullPage: true, caret: "initial" });
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

  // The owner's inbox: log a phone enquiry and open it.
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
  if (response?.headers()["referrer-policy"] !== "no-referrer")
    problems.push("public page lacks Referrer-Policy: no-referrer");
  // The token path is gone (3.2f): nothing answers under /j/.
  const oldLink = await fetch(`${APP}/j/${"x".repeat(43)}`, { redirect: "manual" });
  if (oldLink.status !== 404) problems.push(`an old /j/ link answered ${oldLink.status}`);
  await visitor.close();

  // A new customer's request (D15): "New work" asks them to sign in on the bare domain first, by email code,
  // and comes back to the form. Its own address, so runs never share counters; its own mobile, because a
  // number on another customer's record is refused.
  const customer = await browser.newContext({
    viewport: WIDTHS.phone,
    extraHTTPHeaders: { "x-client-ip": `browser-${run}` },
    geolocation: { latitude: 18.5074, longitude: 73.8077 },
    permissions: ["geolocation"],
  });
  const form = await customer.newPage();
  watchConsole(form, "request form");
  await form.goto(`${APP}/b/sharma-cooling`);
  await form.getByRole("link", { name: "New work" }).click();
  await signInAs(form, customerEmail);
  await form.waitForURL(`${PUBLIC}/b/sharma-cooling/request`);
  await shoot(form, "11-request-form");
  // A first-time customer sees only the fields (3.2g), and their entry also becomes their own name and mobile.
  if (await form.inputValue("input[name=contactName]"))
    problems.push("a first-time customer's form is filled in from someone else's record");
  if (await form.locator("input[name=addressId]").count())
    problems.push("a first-time customer is offered saved addresses");
  if (!(await form.isChecked("input[name=saveAddress]")))
    problems.push('"Save for next time" is not on by default');
  if ((await form.inputValue("input[name=label]")) !== "Home")
    problems.push("a first place is not offered to be saved as Home");
  await form.getByLabel("Your name").fill("Browser Check");
  await form.getByLabel("Your mobile number").fill(`9${String(Date.now()).slice(-9)}`);
  await form.fill("textarea[name=address]", "1 Check Road, Pune");
  // "Use my current location" fills the address from the picked point (D16). The lookup is answered here, in
  // the browser, so the check never sends a point to OpenStreetMap; geocode.test.ts covers the server's side.
  const picked = "Shanti Apartments, Kothrud, Pune, Maharashtra, 411038";
  await form.route("**/request/place", (route) => route.fulfill({ json: { address: picked } }));
  await form.getByRole("button", { name: "Use my current location" }).click();
  await form.getByText("Location added").waitFor();
  if ((await form.inputValue("textarea[name=address]")) !== picked)
    problems.push("the picked location's address is not in the address box");
  if ((await form.inputValue("input[name=latitude]")) !== "18.507400")
    problems.push("the picked point is not in the form");
  await shoot(form, "11a-request-location-picked");
  await form.unroute("**/request/place");
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
    .locator('input[type="file"][name$=".photo"]')
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
  // The request lands in their work list; a request's details and photo are checked on its page further on.
  await form.waitForURL(`${PUBLIC}/b/sharma-cooling/requests`);
  const sent = await form.locator(".cards > li").allTextContents();
  if (sent.length !== 1 || !sent[0]?.includes("AC gas refill"))
    problems.push(`the new customer's work list shows ${JSON.stringify(sent)}`);
  await shoot(form, "13-request-sent");
  // Asked again, the place they saved is offered and chosen, and no typed fields show.
  await form.goto(`${PUBLIC}/b/sharma-cooling/request`);
  const savedHome = form.locator("label.choice.place", { hasText: "Home · Browser Check" });
  if (!(await savedHome.count()) || !(await savedHome.locator("input").isChecked()))
    problems.push("a returning customer's saved address is not offered and preselected");
  if (await form.locator("input[name=contactName]").count())
    problems.push("the typed place fields show while a saved address is chosen");

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
  // The place lookup (D16) spends the app's share of the geocoder: customers only, from our own pages only.
  const placeAt = `${PUBLIC}/b/sharma-cooling/request/place`;
  const nowhere = { latitude: 0, longitude: 0 };
  const placeAnonymous = await fetch(placeAt, {
    method: "POST",
    headers: { origin: PUBLIC, "content-type": "application/json" },
    body: JSON.stringify(nowhere),
  });
  if (placeAnonymous.status !== 401)
    problems.push(`a place lookup without a session answered ${placeAnonymous.status}`);
  const placeCrossSite = await customer.request.post(placeAt, {
    headers: { "sec-fetch-site": "cross-site", origin: PUBLIC },
    data: nowhere,
  });
  if (placeCrossSite.status() !== 403)
    problems.push(`a cross-site place lookup answered ${placeCrossSite.status()}`);
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

  // The quote on the customer's request page (D15, 3.2f). The same customer asks the new business for work
  // with a detail and a photo; the owner quotes it with a discount line, she offers a lower price on her page,
  // the owner revises, and she accepts. Every answer is a post from her own signed-in page; no link holds a secret.
  await form.goto(`${PUBLIC}/b/${slug}/request`);
  await form.getByLabel("Your name").fill("Quote Check");
  await form.getByLabel("Your mobile number").fill(`8${String(Date.now()).slice(-9)}`);
  await form.fill("textarea[name=address]", "2 Quote Lane, Pune");
  await form.getByRole("button", { name: "Add work item" }).click();
  await editor().getByLabel("What needs doing?").fill("Fan not working");
  await editor().getByLabel("Details (optional)").fill("Hall fan hums but does not turn.");
  await editor()
    .locator('input[type="file"][name$=".photo"]')
    .setInputFiles({
      name: "fan.png",
      mimeType: "image/png",
      buffer: Buffer.from(ONE_PIXEL_PNG, "base64"),
    });
  await form.getByRole("button", { name: "Save" }).click();
  await form.getByRole("button", { name: "Send request" }).click();
  await form.waitForURL(`${PUBLIC}/b/${slug}/requests`);
  await form.locator(".cards a").first().click();
  await form.waitForURL(/\/requests\/[0-9a-f-]{36}$/);
  const requestPage = form.url();
  const jobId = requestPage.slice(requestPage.lastIndexOf("/") + 1);
  const sentItem = await form.locator("button.tile.wrap").first().textContent();
  if (!sentItem?.includes("Hall fan hums") || !sentItem.includes("1 photo"))
    problems.push(`the customer's request page shows the item as ${JSON.stringify(sentItem)}`);
  await shoot(form, "13a-customer-request-page");
  // The owner is told by the email of their identity; the customer gets an acknowledgement.
  await expectMail(email, /^New request #\d+ from Quote Check$/, "the owner's new request");
  await expectMail(customerEmail, /has your request #\d+$/, "the customer's acknowledgement");

  // The owner prices the item, adds a discount, has a deposit above the total refused without losing the
  // lines, and sends; the link to pass on is her request page, which needs her sign-in.
  await page.goto(`${APP}/jobs`);
  await page.locator(".cards a.card", { hasText: "Quote Check" }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobUrl = page.url();
  await page.getByRole("button", { name: "Write a quote" }).click();
  await page.waitForURL(/\/quote$/);
  await page.locator("input[name=price]").first().fill("800");
  await shoot(page, "13b-quote-draft");
  await page.getByRole("button", { name: "Custom line" }).click();
  await page.locator("input[name=description]").last().fill("Discount");
  await page.locator("input[name=price]").last().fill("-55");
  await page.fill("input[name=deposit]", "999999");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("alert").filter({ hasText: "deposit cannot be more" }).waitFor();
  if ((await page.locator("input[name=description]").count()) !== 2)
    problems.push("a refused quote save lost a line");
  await shoot(page, "13c-quote-refused");
  await page.fill("input[name=deposit]", "");
  await page.getByRole("button", { name: "Send quote" }).click();
  await page.getByRole("status").filter({ hasText: "is sent" }).waitFor();
  const shared = await page.getByLabel("Customer link").inputValue();
  if (shared !== requestPage) problems.push(`the owner is given ${shared} to pass on`);
  await shoot(page, "13d-quote-sent");

  await form.goto(requestPage);
  if (!(await form.getByRole("heading", { name: "Your quote" }).count()))
    problems.push("the customer's request page does not show the sent quote");
  if (!(await form.getByText("Discount").count()))
    problems.push("the customer's quote lacks the discount line");
  await shoot(form, "13e-customer-quote");
  // Her answer's own guards: another site's post is refused; another business's or customer's job is a 404,
  // to read or to answer, even from her own pages.
  // Each probe names a job together with its own sent quote, so only the customer scope can refuse it.
  const answerTo = (s: string, id: string) => `${PUBLIC}/b/${s}/requests/${id}/answer`;
  const myQuote = await form.locator("input[name=quote]").first().inputValue();
  const crossSite = await customer.request.post(answerTo(slug, jobId), {
    headers: { "sec-fetch-site": "cross-site", origin: PUBLIC },
    form: { quote: myQuote, answer: "accept" },
    maxRedirects: 0,
  });
  if (crossSite.status() !== 403)
    problems.push(`a cross-site answer to a quote answered ${crossSite.status()}`);
  // Sharma's #2 and its sent quote (seed.sql) are someone else's.
  const SHARMA_2 = "10000000-0000-4000-8000-0000000e0002";
  const SHARMA_2_QUOTE = "10000000-0000-4000-8000-000000100001";
  for (const [whose, s, id, quote] of [
    ["another business's", "sharma-cooling", jobId, myQuote],
    ["another customer's", "sharma-cooling", SHARMA_2, SHARMA_2_QUOTE],
  ] as const) {
    const read = await customer.request.get(`${PUBLIC}/b/${s}/requests/${id}`);
    if (read.status() !== 404) problems.push(`${whose} request page answered ${read.status()}`);
    const answered = await customer.request.post(answerTo(s, id), {
      headers: { "sec-fetch-site": "same-origin" },
      form: { quote, answer: "accept" },
      maxRedirects: 0,
    });
    if (answered.status() !== 404)
      problems.push(`an answer to ${whose} quote answered ${answered.status()}`);
  }

  // Negotiation: she offers a lower price; the owner sees it and revises; she accepts the new version, after
  // which the owner is offered no revision and she sees the work with its photo.
  await form.getByText("Offer a different price").click();
  await form.fill("input[name=total]", "400");
  await form.fill("textarea[name=note]", "Can you do it for 400?");
  await form.getByRole("button", { name: "Send my price" }).click();
  await form.getByRole("status").filter({ hasText: "Your price is sent" }).waitFor();
  if (await form.getByRole("button", { name: /Accept quote/ }).count())
    problems.push("a countered quote still offers acceptance");
  await shoot(form, "13f-customer-countered");
  await expectMail(email, /^Quote Check offered a different price/, "the owner's counter notice");
  await page.goto(jobUrl);
  if (!(await page.getByText("offered ₹400.00").count()))
    problems.push("the owner does not see the counter-offer");
  await shoot(page, "13g-job-countered");
  await page.getByRole("button", { name: "Revise the quote" }).click();
  await page.waitForURL(/\/quote$/);
  await page.getByRole("button", { name: "Send quote" }).click();
  await page.getByRole("status").filter({ hasText: "is sent" }).waitFor();
  await form.goto(requestPage);
  await form.getByRole("button", { name: /Accept quote/ }).click();
  await form.getByRole("status").filter({ hasText: "has your acceptance" }).waitFor();
  await expectMail(email, /^Quote Check accepted your quote/, "the owner's acceptance notice");
  await expectMail(customerEmail, /^Your quote from /, "the customer's quote");
  if (await form.locator("button.tile.wrap").count())
    problems.push("an accepted request still offers its items for editing");
  if (!(await form.getByText("Hall fan hums").count()))
    problems.push("the accepted request does not show the item's details");
  // Lazy-loaded, so brought into view first; decode() settles once the signed URL has answered.
  const photo = form.locator(".photos img").first();
  await photo.scrollIntoViewIfNeeded();
  const loaded = await photo.evaluate((img: HTMLImageElement) =>
    img.decode().then(
      () => img.naturalWidth > 0,
      () => false,
    ),
  );
  if (!loaded) problems.push("the accepted request's photo does not load");
  await form.evaluate(() => window.scrollTo(0, 0));
  await shoot(form, "13h-customer-accepted");
  await page.goto(jobUrl);
  if (!(await page.getByText("accepted this quote").count()))
    problems.push("the owner does not see the acceptance");
  if (await page.getByRole("button", { name: "Revise the quote" }).count())
    problems.push("an accepted quote still offers a revision");
  await shoot(page, "13i-job-accepted");

  // Agreeing the time (3.1b): the owner proposes the work's time; the job stays accepted until she confirms.
  // She asks for another, with a note the owner sees; the owner proposes again and she confirms.
  const proposeAt = async (start: string) => {
    await page.goto(jobUrl);
    await page.fill("input[name=start]", start);
    await page.getByRole("button", { name: "Plan it" }).click();
    await page.getByText("Waiting for the customer to confirm").waitFor();
  };
  await proposeAt("2031-04-01T10:00");
  await shoot(page, "13j-job-time-proposed");
  await expectMail(customerEmail, /proposes .* for your work$/, "the customer's proposed time");
  await form.goto(requestPage);
  if (!(await form.getByRole("button", { name: "Confirm this time" }).count()))
    problems.push("the customer is not asked to confirm the proposed time");
  const visitTo = (s: string, id: string) => `${PUBLIC}/b/${s}/requests/${id}/visit`;
  const proposal = await form.locator("input[name=appointment]").first().inputValue();
  const crossSiteVisit = await customer.request.post(visitTo(slug, jobId), {
    headers: { "sec-fetch-site": "cross-site", origin: PUBLIC },
    form: { appointment: proposal, answer: "confirm" },
    maxRedirects: 0,
  });
  if (crossSiteVisit.status() !== 403)
    problems.push(`a cross-site answer to a time answered ${crossSiteVisit.status()}`);
  for (const [whose, s, id] of [
    ["another business's", "sharma-cooling", jobId],
    ["another customer's", "sharma-cooling", SHARMA_2],
  ] as const) {
    const answered = await customer.request.post(visitTo(s, id), {
      headers: { "sec-fetch-site": "same-origin" },
      form: { appointment: proposal, answer: "confirm" },
      maxRedirects: 0,
    });
    if (answered.status() !== 404)
      problems.push(`an answer to ${whose} time answered ${answered.status()}`);
  }
  await shoot(form, "13k-customer-time-proposed");
  await form.getByText("Ask for another time").first().click();
  await form.fill("textarea[name=note]", "Afternoons, please");
  await form.getByRole("button", { name: "Ask for another time" }).click();
  await form.getByRole("status").filter({ hasText: "will propose another time" }).waitFor();
  await expectMail(email, /asks for another time/, "the owner's notice of a declined time");
  await page.goto(jobUrl);
  if (!(await page.getByText('"Afternoons, please"').count()))
    problems.push("the owner does not see the customer's note on the time");
  await proposeAt("2031-04-01T15:00");
  await form.goto(requestPage);
  await form.getByRole("button", { name: "Confirm this time" }).click();
  await form.getByRole("status").filter({ hasText: "The time is confirmed" }).waitFor();
  await expectMail(email, /confirmed .*\(#/, "the owner's notice of a confirmed time");
  await expectMail(customerEmail, /your work visit on /, "the customer's confirmed visit");
  await shoot(form, "13l-customer-time-confirmed");
  await page.goto(jobUrl);
  if (await page.getByText("Waiting for the customer to confirm").count())
    problems.push("a confirmed time still waits for the customer");
  if (!(await page.getByText("Scheduled").count()))
    problems.push("the job is not scheduled once the customer confirmed");
  await shoot(page, "13m-job-scheduled");
  await customer.close();

  // A signed-in customer (D15): seeded Anita opens "My requests" on the bare domain, signs in there, and sees
  // only her request with Sharma. Her cookie is the customer one, on the bare domain only, and the app host
  // does not take her as a member.
  const anita = await browser.newContext({
    viewport: WIDTHS.phone,
    extraHTTPHeaders: { "x-client-ip": `anita-${run}` },
    geolocation: { latitude: 18.5155, longitude: 73.8563 },
    permissions: ["geolocation"],
  });
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
  // Where and who (3.2g): her saved addresses, Home (last used) preselected; she asks for work at her
  // parents' house, where her father is the one to meet.
  await space.goto(`${PUBLIC}/b/sharma-cooling/request`);
  const places = space.locator("label.choice.place");
  const offered = await places.allTextContents();
  if (
    offered.length !== 3 ||
    !offered[0]?.includes("Home") ||
    !offered[1]?.includes("Parents · Vasant Deshpande") ||
    !offered[2]?.includes("Somewhere else")
  )
    problems.push(`the request form offers ${JSON.stringify(offered)}`);
  if (!(await places.first().locator("input").isChecked()))
    problems.push("the last used address is not preselected");
  await shoot(space, "16a-request-where-and-who");
  await places.filter({ hasText: "Parents" }).click();
  await space.getByRole("button", { name: "Add work item" }).click();
  await space
    .locator(".sheet:not([hidden])")
    .getByLabel("What needs doing?")
    .fill("AC general service");
  await space.getByRole("button", { name: "Save" }).click();
  await space.getByRole("button", { name: "Send request" }).click();
  await space.waitForURL(`${PUBLIC}/b/sharma-cooling/requests`);
  // Another customer's saved address (Rahul's, seed.sql), posted from her own pages, is refused.
  const RAHUL_HOME = "10000000-0000-4000-8000-000000110003";
  const sameSite = { "sec-fetch-site": "same-origin" };
  const forgedSend = await anita.request.post(sendTo("sharma-cooling"), {
    headers: sameSite,
    multipart: { addressId: RAHUL_HOME, "item.0.title": "Forged" },
    maxRedirects: 0,
  });
  if (!forgedSend.headers().location?.endsWith("?error=address"))
    problems.push(`a request to another customer's address answered ${forgedSend.status()}`);

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
  // Her own name and mobile change only here, in the Edit sheet.
  const sheet = () => space.locator(".sheet:not([hidden])");
  await space.getByRole("button", { name: "Edit" }).click();
  await sheet().getByLabel("Your name").fill("Anita D");
  await shoot(space, "16c-profile-details-sheet");
  await sheet().getByRole("button", { name: "Save" }).click();
  await space.waitForURL(/saved=details/);
  if (!(await space.locator("dl.facts").textContent())?.includes("Anita D"))
    problems.push("the edited name is not on the profile");
  // An address added with "Use my current location" (answered here, as on the form), changed, then deleted.
  await space.route("**/request/place", (route) =>
    route.fulfill({ json: { address: "Shop 3, Laxmi Road, Pune" } }),
  );
  await space.getByRole("button", { name: "Add address" }).click();
  await sheet().getByLabel("Save as").fill("Shop");
  await sheet().getByLabel("Person to meet").fill("Ravi");
  await sheet().getByLabel("Their mobile number").fill("90000 01099");
  await sheet().getByRole("button", { name: "Use my current location" }).click();
  await sheet().getByText("Location added").waitFor();
  await shoot(space, "16d-profile-address-sheet");
  await sheet().getByRole("button", { name: "Save" }).click();
  await space.waitForURL(/saved=address/);
  const shop = space.locator("button.tile", { hasText: "Shop" });
  if (!(await shop.textContent())?.includes("Laxmi Road"))
    problems.push("the added address is not in the book");
  await shoot(space, "16e-profile-addresses");
  await shop.click();
  await sheet().getByLabel("Person to meet").fill("Ravi K");
  await sheet().getByRole("button", { name: "Save" }).click();
  await space.waitForURL(/saved=address/);
  if (!(await shop.textContent())?.includes("Ravi K"))
    problems.push("the address edit did not save");
  await shop.click();
  await sheet().getByRole("button", { name: "Delete this address" }).click();
  await space.waitForURL(/saved=deleted/);
  if ((await space.locator("button.tile").count()) !== 2)
    problems.push("the deleted address is still in the book");
  // Profile's posts: another customer's address is a 404 to change or delete; another site's post is refused.
  const addressAt = `${PUBLIC}/b/sharma-cooling/profile/address`;
  for (const intent of ["save", "delete"]) {
    const forged = await anita.request.post(addressAt, {
      headers: sameSite,
      form: {
        id: RAHUL_HOME,
        intent,
        label: "Mine",
        contactName: "Anita",
        contactPhone: "9000001001",
        address: "Taken",
      },
      maxRedirects: 0,
    });
    if (forged.status() !== 404)
      problems.push(`a ${intent} of another customer's address answered ${forged.status()}`);
  }
  for (const url of [addressAt, `${PUBLIC}/b/sharma-cooling/profile/details`]) {
    const status = (
      await anita.request.post(url, {
        headers: { "sec-fetch-site": "cross-site", origin: PUBLIC },
        form: { name: "Evil", phone: "9000009999" },
        maxRedirects: 0,
      })
    ).status();
    if (status !== 403) problems.push(`a cross-site post to ${url} answered ${status}`);
  }
  await space.getByRole("button", { name: "Sign out" }).click();
  await space.waitForURL(`${PUBLIC}/b/sharma-cooling`);
  if ((await anita.cookies()).some((c) => c.name === "__Host-kk_customer"))
    problems.push("the customer cookie survived sign-out");
  await anita.close();

  // The owner's side of that request: the contact is the person at the address, her father, with Call and
  // WhatsApp to his mobile, and the job says who asked.
  const sharma = await browser.newContext({ viewport: WIDTHS.phone });
  const ownerPage = await sharma.newPage();
  watchConsole(ownerPage, "owner job for someone else");
  await ownerPage.goto(`${APP}/jobs`);
  await signInAs(ownerPage, "prakash@example.com");
  await ownerPage.waitForURL(`${APP}/jobs`);
  await ownerPage.locator(".cards a.card").first().click();
  await ownerPage.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
  const contactCard = await ownerPage.locator(".card").first().textContent();
  if (!contactCard?.includes("Vasant Deshpande") || !contactCard.includes("Requested by Anita D"))
    problems.push(`the owner's job for someone else shows ${JSON.stringify(contactCard)}`);
  if (!(await ownerPage.getByRole("link", { name: "Call" }).getAttribute("href"))?.endsWith("1011"))
    problems.push("the owner's Call does not ring the person at the address");
  await shoot(ownerPage, "16f-owner-job-for-someone-else");
  await sharma.close();
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
