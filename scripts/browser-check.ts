// Phase-end browser check: `pnpm run check:browser`, against the running dev stack (`pnpm run up:fresh`,
// the platform container, `pnpm --filter kaamkoti dev`). Chromium lives on D: (set
// PLAYWRIGHT_BROWSERS_PATH=D:\playwright-browsers; install with `pnpm exec playwright install chromium-headless-shell`). A new owner signs in with an email code read from
// Mailpit, creates a business, picks a trade, edits a price, and the public page and a customer's job link are
// opened without cookies. A customer sends a request with a photo through the public form and lands on their
// job link, where the photo loads by signed URL; intake and /j/ answer 429 past their per-IP limits.
// Each page is screenshotted at phone and desktop width into .validation/browser/; the run fails on a console
// error, a page wider than the viewport, or a cookie on the public page.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page } from "playwright";

const APP = "http://127.0.0.1:45450";
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

async function signInCode(): Promise<string> {
  for (let tries = 0; tries < 50; tries++) {
    const found = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
    );
    if (!found.ok) throw new Error(`mailpit search failed: ${found.status}`);
    const { messages } = (await found.json()) as { messages: { Subject: string }[] };
    const code = messages[0]?.Subject.match(/^(\d{6}) /)?.[1];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no sign-in code arrived for ${email}`);
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
  await page.waitForURL(/\/sign-in/);
  await shoot(page, "2-sign-in");
  await page.fill("input[name=email]", email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("input[name=code]").waitFor({ state: "visible" });
  await page.fill("input[name=code]", await signInCode());
  await page.getByRole("button", { name: "Continue" }).click();

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

  // A customer's request through the public form, cookieless. Its own address, so runs never share counters.
  const customer = await browser.newContext({
    viewport: WIDTHS.phone,
    extraHTTPHeaders: { "x-client-ip": `browser-${run}` },
  });
  const form = await customer.newPage();
  watchConsole(form, "request form");
  await form.goto(`${APP}/b/sharma-cooling`);
  await form.getByRole("link", { name: "Request a visit" }).click();
  await form.waitForURL(`${APP}/b/sharma-cooling/request`);
  await shoot(form, "11-request-form");
  const fill = async () => {
    await form.selectOption("select[name='q.appliance']", "Split AC");
    await form.selectOption("select[name='q.symptom']", "Not cooling");
    await form.fill("input[name=name]", "Browser Check");
    await form.fill("input[name=phone]", "98765 00000");
    await form.fill("textarea[name=address]", "1 Check Road, Pune");
  };
  // No service picked: the form comes back with the reason.
  await fill();
  await form.getByRole("button", { name: "Send request" }).click();
  await form.waitForURL(/\?error=tasks$/);
  if (!(await form.getByRole("alert").filter({ hasText: "at least one service" }).count()))
    problems.push("a request without a service is not explained");
  await shoot(form, "12-request-form-error");
  await fill();
  await form.getByRole("checkbox", { name: /AC gas refill/ }).check();
  await form.setInputFiles("input[name='photo.photo']", {
    name: "ac.png",
    mimeType: "image/png",
    buffer: Buffer.from(ONE_PIXEL_PNG, "base64"),
  });
  await form.getByRole("button", { name: "Send request" }).click();
  await form.waitForURL(/\/j\/[A-Za-z0-9_-]{43}$/);
  if (!(await form.getByText("AC gas refill").count()))
    problems.push("the new request's link does not list its task");
  const photo = form.getByRole("img", { name: "Sent with your request" });
  await photo.waitFor();
  if (!(await photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)))
    problems.push("the request photo does not load by its signed URL");
  await shoot(form, "13-request-sent");
  if ((await customer.cookies()).length > 0) problems.push("customer context holds cookies");
  await customer.close();

  // Past the limits. Intake counts before it looks at the slug, so an unknown one keeps real counters clean.
  const hammer = async (url: string, method: string, times: number) => {
    let last = 0;
    for (let i = 0; i < times; i++)
      last = (
        await fetch(url, {
          method,
          redirect: "manual",
          headers: { "x-client-ip": `limit-${run}` },
          ...(method === "POST" ? { body: new FormData() } : {}),
        })
      ).status;
    return last;
  };
  const intake = await hammer(`${APP}/b/limit-check-${run}/request/send`, "POST", 11);
  if (intake !== 429) problems.push(`intake past its limit answered ${intake}`);
  const lookups = await hammer(`${APP}/j/${"y".repeat(43)}`, "GET", 61);
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
