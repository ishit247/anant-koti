# UI guidelines (Kaam Koti)

How screens are built, so the next one looks and behaves like the rest. The source of truth is
[apps/kaamkoti/src/app/globals.css](../apps/kaamkoti/src/app/globals.css); this file says how to use it.
Established in step 2.3. Change a rule here and in the CSS in the same commit.

## Principles

1. **Phone first.** The base CSS is the phone layout (375 px). Wider screens only get more room
   (`min-width` media queries, one column of at most 34 rem). Never design the desktop and shrink it.
2. **One thumb, one job per screen.** The main action is one full-width or prominent button. Secondary
   actions are `quiet`. Destructive or rare actions are `quiet` and worded plainly.
3. **Plain and fast.** Server components by default; client JavaScript only for forms with feedback, copy
   buttons and similar. No web fonts, no icon library, no images except customer photos. The first paint is text.
4. **Say what happened.** Every form answers in words (`role="alert"` for errors, `role="status"` for
   success). Empty lists explain what to do next. Never a blank or broken page.
5. **Customers and owners see the same style.** Customer pages (`/b/`, `/j/`) use the same cards and
   buttons but no tab bar and no cookies.

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

Contrast: text on `--paper` and `--card` meets WCAG AA; keep it so when adding a tone.

## Building blocks

| Need                         | Use                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Page title with an action    | `<header className="bar"><h1>…</h1><a className="button">…</a></header>`            |
| Section heading              | `<h2>` (small caps label style; do not restyle)                                     |
| A thing, or a group of facts | `.card`; a clickable one is `<a className="card">`                                  |
| A list of things             | `<ul className="cards"><li><a className="card">…</a></li></ul>`; row inside: `.row` |
| Label and value pairs        | `<dl className="facts card">` with `dt` and `dd`                                    |
| Status                       | `.chip` plus `new`, `go` or `wait` (`statusTone()`, `quoteTone()`, job-labels.ts)   |
| Headline number / entry card | `.card.stat` (brand colour, count on the right)                                     |
| Two or three buttons         | `.actions` (equal-width grid that wraps)                                            |
| Photos                       | `.photos` (square thumbnails, `loading="lazy"`)                                     |
| Priced lines and totals      | `QuoteSummary`: `ul.lines` of `.row`s, `.row.total`, figures in `.amount`           |
| Nothing here yet             | `<p className="empty">` with the next step in words                                 |
| A rare or second action      | `<details className="card">` with a `summary` verb, the form inside (no JavaScript) |
| One form, two views          | Main view a `.stack`, the other a `fieldset.sheet`, toggled with `hidden`           |
| Customer page header         | `header.hero`: `.who` (`.avatar` initial + business name), `h1`, one muted line     |
| A step of a form             | `section.panel` with an `h2` (sentence case; `.count` badge for a list)             |
| A row to tap open            | `button.tile`: `.thumb`, `.text` (two lines), `.price`, `Icon name="chevron"`       |
| Add another                  | `button.add` (dashed, with `Icon name="plus"`) closing a list of tiles              |
| The screen's main action     | `.dock` at the end of the view: sticky at the bottom, full-width primary button     |
| A screen inside a page       | `.sheet` with `.sheet-head` (`button.icon` back arrow + `h2`)                       |
| Small inline action / state  | `button.link` (with an icon); `.pill` for a done state with a remove `×`            |
| Photo picker                 | `label.drop` around a `.visually-hidden` file input; `.thumbs` previews below       |
| Icons                        | `Icon` in `app/icons.tsx` (inline SVG, always beside words, `aria-hidden`)          |
| Link to pass on              | `ShareLink` (copy and WhatsApp), never a hand-built share row                       |
| Member navigation            | `OwnerNav` at the end of every owner page, with `current` set                       |

Buttons: primary is the default `button`/`.button`; `quiet` is outlined. Minimum height 2.75 rem
(44 px); labels never wrap. One primary button per card or screen section.

## Forms

- One column, `label` wrapping its input (label above field), no placeholder as label.
- Right input type and `inputMode` (`tel`, `number`), `autoComplete` where it helps, `required` and
  `maxLength` matching the server's rules. Inputs are at least 16 px so iOS does not zoom.
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
- Visible focus (`:focus-visible` is global); never remove it.
- Colour is never the only signal: chips carry text, errors carry words.
- Images have `alt`; decorative glyphs are `aria-hidden`.
- Motion only under `prefers-reduced-motion: no-preference`, and only colour transitions.

## Checking a screen

Before a UI step is done (see CLAUDE.md, "How much verification"):

1. Add the screen to `scripts/browser-check.ts` if it is a main flow; it fails on console errors, horizontal
   overflow and cookies on public pages.
2. Look at the screenshots in `.validation/browser/` at 375 px and 1280 px. The test does not judge looks.
3. Check the long-text case (a long name, a long address) and the empty case.

## Adding to the system

Reuse first. A new class is added to `globals.css` only when a second screen needs it, with a token for
every colour, and is then listed in the table above. No CSS framework, no per-page stylesheet.
