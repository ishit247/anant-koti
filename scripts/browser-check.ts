// Phase-end browser check: `pnpm run check:browser`, against the running dev stack (`pnpm run up:fresh`,
// the platform container, `pnpm --filter kaamkoti dev`). Chromium lives on D: (set
// PLAYWRIGHT_BROWSERS_PATH=D:\playwright-browsers; install with `pnpm exec playwright install chromium-headless-shell`). A new owner signs in with an email code read from
// Mailpit, creates a business, picks a trade, edits a price, and the public page and a customer's job link are
// opened without cookies.
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
