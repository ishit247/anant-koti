// Kaam Koti's message templates (docs/architecture.md 9.2), one version per channel. Variables arrive as display
// text the app formatted; a template only places them. WhatsApp versions join in 3.3, mirroring Meta's approved
// templates. Customers' links open their own page on the bare domain, behind their sign-in; owners' links open
// the job in the app.
import { z } from "zod";
import { defineTemplate } from "./template.ts";

const text = z.string().min(1).max(200);
const link = z.url({ protocol: /^https?$/ });
/** The request's number, as the owner's list shows it ("#12"). */
const number = z.string().regex(/^#[0-9]{1,9}$/);

const SIGN_IN = "Sign in there with this email address to see it.";

export const kaamkoti = {
  /** To the owner: a customer sent a request from the business's page. */
  "request.received": defineTemplate({
    vars: z.object({ customerName: text, number, items: z.string().min(1).max(600), link }),
    email: (v) => ({
      subject: `New request ${v.number} from ${v.customerName}`,
      text:
        `${v.customerName} has sent request ${v.number}:\n${v.items}\n\n` +
        `Open it to quote:\n${v.link}`,
    }),
  }),
  /** To the customer: the business has their request. */
  "request.acknowledged": defineTemplate({
    vars: z.object({ customerName: text, businessName: text, number, link }),
    email: (v) => ({
      subject: `${v.businessName} has your request ${v.number}`,
      text:
        `Hello ${v.customerName},\n\n` +
        `${v.businessName} has your request ${v.number}. You will hear back with a quote.\n\n` +
        `Follow it here:\n${v.link}\n\n${SIGN_IN}`,
    }),
  }),
  /** To the owner: the customer changed the work items or the place; an open quote was set aside. */
  "request.edited": defineTemplate({
    vars: z.object({ customerName: text, number, link }),
    email: (v) => ({
      subject: `${v.customerName} changed request ${v.number}`,
      text:
        `${v.customerName} has changed request ${v.number}. ` +
        `A quote they had not answered no longer counts: see the changes and quote again.\n\n${v.link}`,
    }),
  }),
  "quote.sent": defineTemplate({
    vars: z.object({
      customerName: text,
      businessName: text,
      total: text,
      validUntil: text,
      link,
    }),
    email: (v) => ({
      subject: `Your quote from ${v.businessName}: ${v.total}`,
      text:
        `Hello ${v.customerName},\n\n` +
        `${v.businessName} has sent you a quote for ${v.total}, valid until ${v.validUntil}.\n\n` +
        `See the details and answer here:\n${v.link}\n\n${SIGN_IN}`,
    }),
  }),
  /** To the owner: the customer's answer to a quote. A counter carries the price they offered. */
  "quote.response": defineTemplate({
    vars: z.discriminatedUnion("answer", [
      z.object({
        answer: z.enum(["accepted", "rejected"]),
        customerName: text,
        number,
        total: text,
        link,
      }),
      z.object({
        answer: z.literal("countered"),
        customerName: text,
        number,
        total: text,
        offered: text,
        link,
      }),
    ]),
    email: (v) => {
      const [headline, said] =
        v.answer === "countered"
          ? ["offered a different price", `offered ${v.offered} for your quote of ${v.total}`]
          : v.answer === "accepted"
            ? ["accepted your quote", `accepted your quote of ${v.total}`]
            : ["turned down your quote", `turned down your quote of ${v.total}`];
      return {
        subject: `${v.customerName} ${headline} (${v.number})`,
        text: `${v.customerName} has ${said} on request ${v.number}.\n\n${v.link}`,
      };
    },
  }),
  /** To the owner: a quote nobody answered ran out (the job at its `valid_until`). */
  "quote.expired": defineTemplate({
    vars: z.object({ customerName: text, number, total: text, link }),
    email: (v) => ({
      subject: `Your quote to ${v.customerName} has expired (${v.number})`,
      text:
        `${v.customerName} did not answer your quote of ${v.total} on request ${v.number} in time, ` +
        `so it can no longer be accepted. Send a new one if the work is still wanted:\n${v.link}`,
    }),
  }),
  /** To the customer: the business proposes a time for the work, to confirm or change on their page. */
  "appointment.proposed": defineTemplate({
    vars: z.object({ customerName: text, businessName: text, when: text, link }),
    email: (v) => ({
      subject: `${v.businessName} proposes ${v.when} for your work`,
      text:
        `Hello ${v.customerName},\n\n` +
        `${v.businessName} can come to do the work on ${v.when}. ` +
        `Please confirm the time, or ask for another one:\n${v.link}\n\n${SIGN_IN}`,
    }),
  }),
  /** To the owner: the customer confirmed the proposed time, or asked for another (with their note, if any). */
  "appointment.response": defineTemplate({
    vars: z.discriminatedUnion("answer", [
      z.object({ answer: z.literal("confirmed"), customerName: text, number, when: text, link }),
      z.object({
        answer: z.literal("declined"),
        customerName: text,
        number,
        when: text,
        note: z.string().min(1).max(500).optional(),
        link,
      }),
    ]),
    email: (v) =>
      v.answer === "confirmed"
        ? {
            subject: `${v.customerName} confirmed ${v.when} (${v.number})`,
            text: `${v.customerName} has confirmed the work on ${v.when} for request ${v.number}.\n\n${v.link}`,
          }
        : {
            subject: `${v.customerName} asks for another time (${v.number})`,
            text:
              `${v.customerName} cannot do ${v.when} for request ${v.number}` +
              `${v.note ? ` and says:\n"${v.note}"` : "."}\n\nPropose another time:\n${v.link}`,
          },
  }),
  /** To the customer: a visit was planned, or moved to another time. */
  "appointment.confirmed": defineTemplate({
    vars: z.object({
      customerName: text,
      businessName: text,
      visit: z.enum(["work visit", "site visit"]),
      when: text,
      link,
    }),
    email: (v) => ({
      subject: `${v.businessName}: your ${v.visit} on ${v.when}`,
      text:
        `Hello ${v.customerName},\n\n` +
        `${v.businessName} will come for a ${v.visit} on ${v.when}.\n\n` +
        `Your request:\n${v.link}\n\n${SIGN_IN}`,
    }),
  }),
};
