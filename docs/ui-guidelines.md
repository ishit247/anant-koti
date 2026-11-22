# UI guidelines (Kaam Koti)

How screens are built, so the next one looks and behaves like the rest. The source of truth is
[apps/kaamkoti/src/app/globals.css](../apps/kaamkoti/src/app/globals.css); this file says how to use it.
Established in step 2.3; the look was refreshed on 2026-11-22 (filled inputs, panels, tiles, a docked main
action), starting with the request form. Change a rule here and in the CSS in the same commit.

## Principles

1. **Phone first.** The base CSS is the phone layout (375 px). Wider screens only get more room
   (`min-width` media queries, one column of at most 34 rem). Never design the desktop and shrink it.
2. **One thumb, one job per screen.** The main action is one full-width primary button, docked at the
   bottom of the screen (`.dock`) when the page scrolls. Secondary actions are `quiet` or `link`;
   destructive or rare ones are `danger` or `quiet`, worded plainly, and live where the thing is edited, not
   on every row of a list.
3. **Plain and fast.** Server components by default; client JavaScript only for forms with feedback, copy
   buttons and similar. No web fonts, no icon library (a few inline SVG icons in `app/icons.tsx`), no images
   except customer photos. The first paint is text.
4. **Say what happened.** Every form answers in words (`role="alert"` for errors, `role="status"` for
   success). Empty lists explain what to do next. Never a blank or broken page.
5. **Customers and owners see the same style.** Customer pages (`/b/<slug>/…`, the customer space since
   D15) use the same cards and buttons but no tab bar; they carry only the customer's own sign-in cookie. A customer page opens with `BusinessHeader` (a sticky app bar), so the customer sees
   whose page it is before what it asks.
6. **Finished, not a form dump.** Hierarchy does the work: a few `section.panel`s per screen, each a step
   with a sentence-case title; lists of things are `button.tile` rows that open an edit screen (`.sheet`),
   never a column of repeated mini-forms; inputs are filled and soft, not boxed; spacing is even and
   only the main action carries the brand colour. The request form (`/b/[slug]/request`) is the reference
   screen.
7. **Modern, minimal, compact (asked 2026-11-22).** A clean, modern look with no wasted space: tight but
   even spacing, no empty bands, no decoration that carries no meaning. Icons save space where their
   meaning is obvious (edit, delete, call, map, photo, back); an icon-only button always has an
   `aria-label` and a visible text label where the meaning is not obvious. The layout should explain
   itself, so help text is short: at most one line under a field, or behind an info icon. Never a
   paragraph of instructions.

## Tokens

Defined on `:root`; use them, never a literal colour in a component.

| Token                                                   | Use                                         |
| ------------------------------------------------------- | ------------------------------------------- |
| `--ink`, `--muted`                                      | Text, secondary text (`.muted`, `.small`)   |
| `--paper`, `--card`, `--line`                           | Page background, card background, hairlines |
| `--fill`, `--fill-edge`                                 | Filled inputs and tiles, their soft edge    |
| `--shadow`                                              | Depth of cards and panels                   |
| `--field`                                               | Strong borders (rare)                       |
| `--brand`, `--brand-dark`, `--brand-tint`               | Primary action, hover, soft highlight       |
| `--ok` / `--ok-tint`, `--warn` / `--warn-tint`, `--bad` | Positive, waiting, error states             |
| `--radius`, `--tabs`                                    | Card corner radius, tab bar height          |

Contrast: text on `--paper` and `--card` meets WCAG AA; keep it so when adding a tone. A filled input's edge
(`--fill-edge`) is soft on purpose: the input is marked by its fill and its label above it, and a focused
input gets a brand edge and ring. Do not put an input without a visible label on a `--fill` background.

## Building blocks

| Need                         | Use                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Page title with an action    | `<header className="bar"><h1>…</h1><a className="button">…</a></header>`                    |
| Section heading              | `<h2>` (small caps label style); inside `.panel` or `.sheet-head` it is sentence case       |
| A thing, or a group of facts | `.card`; a clickable one is `<a className="card">`                                          |
| A list of things             | `<ul className="cards"><li><a className="card">…</a></li></ul>`; row inside: `.row`         |
| Label and value pairs        | `<dl className="facts card">` with `dt` and `dd`                                            |
| Status                       | `.chip` plus `new`, `go` or `wait` (`statusTone()`, `quoteTone()`, job-labels.ts)           |
| Headline number / entry card | `.card.stat` (brand colour, count on the right)                                             |
| Two or three buttons         | `.actions` (equal-width grid that wraps)                                                    |
| Photos                       | `.photos` (square thumbnails, `loading="lazy"`)                                             |
| Priced lines and totals      | `QuoteSummary`: `ul.lines` of `.row`s, `.row.total`, figures in `.amount`                   |
| Nothing here yet             | `<p className="empty">` with the next step in words                                         |
| A rare or second action      | `<details className="card">` with a `summary` verb, the form inside (no JavaScript)         |
| One form, two views          | Main view a `.stack`, the other a `fieldset.sheet`, toggled with `hidden`                   |
| Customer page header         | `BusinessHeader` (`app/business-header.tsx`): sticky `header.appbar` with back arrow, `.avatar`, name and place; the page's `h1` and one muted line as children, in `.hero` below |
| A step of a form             | `section.panel` with an `h2` (sentence case; `.count` badge for a list)                     |
| A row to tap open            | `button.tile`: `.thumb`, `.text` (two lines), `.price`, `Icon name="chevron"`               |
| Add another                  | `button.add` (dashed, with `Icon name="plus"`) closing a list of tiles                      |
| The screen's main action     | `.dock` at the end of the view: sticky at the bottom, full-width primary button             |
| A screen inside a page       | `.sheet` with `.sheet-head` (`button.icon` back arrow + `h2`)                               |
| Small inline action / state  | `button.link` (with an icon); `.pill` for a done state with a remove `×`                    |
| Photo picker                 | `label.drop` around a `.visually-hidden` file input; `.thumbs` previews below               |
| Icons                        | `Icon` in `app/icons.tsx` (inline SVG, always beside words, `aria-hidden`)                  |
| One list seen several ways   | `nav.seg` of links with `aria-current="page"` (the customer's Active, Completed, Cancelled) |
| Who is signed in             | `form.signed-in`: `.who-email` and a `button.link` "Sign out" posting the form              |
| Link to pass on              | `ShareLink` (copy and WhatsApp), never a hand-built share row                               |
| Member navigation            | `OwnerNav` at the end of every owner page, with `current` set                               |

Buttons: primary is the default `button`/`.button` (3 rem tall, 0.8 rem radius); `quiet` is white with a
soft edge; `link` is text-weight with an icon; `icon` is a round 44 px target (back arrow); `danger` is red
text for removing. Every tap target is at least 44 px; labels never wrap. One primary button per screen,
in the `.dock` when there is one.

Layout of a form screen, top to bottom: `BusinessHeader` (customer pages) or `header.bar` (owner pages), the
refusal message if any, one `section.panel` per step, then the `.dock` with the main action and one muted
line under it saying what happens next.

## Forms

- One column, `label` wrapping its input (label above field). Inputs are filled (`--fill`) and turn white
  with a brand ring on focus. A placeholder is only an example ("House, street, area"), never the label.
- Right input type and `inputMode` (`tel`, `number`), `autoComplete` where it helps, `required` and
  `maxLength` matching the server's rules. Inputs are at least 16 px so iOS does not zoom.
- A short note under a field (a price found, what happens next) is `p.hint`, directly after the field.
- A list the user builds (work items, later price-list items and quote lines) is `button.tile` rows plus a
  `button.add` tile; tapping opens a `.sheet` with the fields, a back arrow (Back undoes, and discards a new
  item) and Save in its own `.dock`. Hidden sheets keep their fields in the form so one post carries all.
- Photos are picked through `label.drop` (the file input inside, `.visually-hidden`), and the chosen ones
  are previewed in `.thumbs` from object URLs before anything is sent.
- Checkbox lists go in `fieldset.item` with `label.choice` rows (whole row is the tap target).
- A refused submit keeps what was typed (state returns `typed`, form re-keyed) and shows one message that
  names the fix, from a table of messages, never raw error text.
- Server validation is the authority; HTML attributes are convenience.
- Pending state: disable the button and change its label ("Saving…").

## Navigation

- Owner pages: bottom tab bar (Home, Requests, Prices), fixed, safe-area aware, current tab marked with
  `aria-current="page"`. A new top-level area becomes a tab only if it is used daily; otherwise link to it
  from Home. Keep at most five tabs.
- Detail pages put a text link back at the top ("← Requests"). Do not rely on the browser's back button.
- Customer pages have no navigation: the business's Call and WhatsApp buttons are the way out.

## Copy

- Plain words a tradesperson would say: "Requests", "Prices", "Phone enquiry", not "Leads" or "Catalogue".
- Buttons are verbs ("Save request", "Send request"). Errors say what to do ("Pick at least one service").
- Times in `Asia/Kolkata`, `en-IN` (`formatWhen`); money through `formatMoney` from `@bodhchakra/money`,
  or `formatPrice` for a price per unit. Amounts carry the business's currency; form labels say ₹ while it is
  INR only.

## Accessibility

- Real elements (`button`, `a`, `label`, `dl`, `nav`), landmarks with names (`nav aria-label="Main"`).
- Visible focus (`:focus-visible` is global); never remove it. Inputs show focus as a brand edge and ring
  instead of the outline; a `label.drop` shows it when its hidden input has focus (`:focus-within`).
- A visually hidden input stays in the form and reachable by keyboard (`.visually-hidden`, never
  `display: none`); an icon-only button has an `aria-label` ("Back", "Remove location").
- Colour is never the only signal: chips carry text, errors carry words.
- Images have `alt`; decorative glyphs are `aria-hidden`.
- Motion only under `prefers-reduced-motion: no-preference`, and only colour transitions.

## Checking a screen

Before a UI step is done (see CLAUDE.md, "How much verification"):

1. Add the screen to `scripts/browser-check.ts` if it is a main flow; it fails on console errors, horizontal
   overflow and cookies on public pages.
2. Look at the screenshots in `.validation/browser/` at 375 px and 1280 px. The test does not judge looks.
   They are full-page captures, so a sticky `.dock` shows mid-page over the content; to judge a docked
   screen, also take a 375 × 812 viewport shot scrolled to the end.
3. Check the long-text case (a long name, a long address) and the empty case.
4. Ask of the screenshot: is it clear whose page it is and what the one main action is, and does it look
   like a product rather than a list of boxes? If not, it is not done.

## Reference screens

| Screen                                  | Look                                                           |
| --------------------------------------- | -------------------------------------------------------------- |
| Request form `/b/[slug]/request`        | Reference: hero, panels, tiles, sheet editor, photo drop, dock |
| Customer home `/b/[slug]/requests`      | Hero, `nav.seg`, cards with status chips, dock "New request"   |
| Customer job `/j/[secret]`, owner pages | New tokens (filled inputs, card depth), old layout             |

The owner screens (price list, quote editor, phone enquiry, job page) and the customer job page move to the
new layout in step 3.2d of the development plan; until then they get the tokens only.

## Adding to the system

Reuse first. A new class is added to `globals.css` only when a second screen needs it, with a token for
every colour, and is then listed in the table above. No CSS framework, no per-page stylesheet. (The
2026-11-22 refresh added its blocks with the request form as their first screen, because the owner
screens adopt them in 3.2d.) A new icon is one path added to `app/icons.tsx`.
