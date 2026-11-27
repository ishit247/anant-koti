// Kaam Koti's message templates (docs/architecture.md 9.2), one version per channel. Variables arrive as display
// text the app formatted; a template only places them. Each also has a WhatsApp version, mirroring the template
// submitted to Meta. Customers' links open their own page on the bare domain, behind their sign-in; owners' links
// open the job in the app.
import { z } from "zod";
import { defineTemplate } from "./template.ts";

const text = z.string().min(1).max(200);
const link = z.url({ protocol: /^https?$/ });
/** The request's number, as the owner's list shows it ("#12"). */
const number = z.string().regex(/^#[0-9]{1,9}$/);

const SIGN_IN = "Sign in there with this email address to see it.";
/**
 * WhatsApp bodies end on this line, not on the link: Meta refuses a template that ends with a parameter. It names
 * no address, since the customer may sign in with their email or (3.3c) this number.
 */
const WA_SIGN_IN = "Sign in on that page to see it.";
/** The owner's WhatsApp messages end on this line: the business's number does not read replies. */
const WA_OWNER_END = "Answer in Kaam Koti; replies here are not read.";

/** What the customer did with a quote, as the owner's message says it. */
const quoteAnswer = (
  v:
    | { answer: "accepted" | "rejected"; total: string }
    | { answer: "countered"; total: string; offered: string },
) =>
  v.answer === "countered"
    ? `offered ${v.offered} for your quote of ${v.total}`
    : v.answer === "accepted"
      ? `accepted your quote of ${v.total}`
      : `turned down your quote of ${v.total}`;

export const kaamkoti = {
  /** To the owner: a customer sent a request from the business's page. */
  "request.received": defineTemplate({
    // One work item per line, each starting "- ".
    vars: z.object({ customerName: text, number, items: z.string().min(1).max(600), link }),
    email: (v) => ({
      subject: `New request ${v.number} from ${v.customerName}`,
      text:
        `${v.customerName} has sent request ${v.number}:\n${v.items}\n\n` +
        `Open it to quote:\n${v.link}`,
    }),
    whatsapp: {
      name: "kaamkoti_request_received",
      body: `New request {{1}} from {{2}}: {{3}}.\n\nOpen it to quote: {{4}}\n\n${WA_OWNER_END}`,
      // A parameter holds no line breaks, so the items become one line.
      params: (v) => [
        v.number,
        v.customerName,
        v.items
          .split("\n")
          .map((item) => item.replace(/^- /, ""))
          .join("; "),
        v.link,
      ],
    },
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
    whatsapp: {
      name: "kaamkoti_request_acknowledged",
      body:
        "Hello {{1}}, {{2}} has your request {{3}}. You will hear back with a quote.\n\n" +
        `Follow it here: {{4}}\n\n${WA_SIGN_IN}`,
      params: (v) => [v.customerName, v.businessName, v.number, v.link],
    },
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
    whatsapp: {
      name: "kaamkoti_request_edited",
      body:
        "Request {{1}} was changed by {{2}}. A quote they had not answered no longer counts: " +
        `see the changes and quote again: {{3}}\n\n${WA_OWNER_END}`,
      params: (v) => [v.number, v.customerName, v.link],
    },
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
    whatsapp: {
      name: "kaamkoti_quote_sent",
      body:
        "Hello {{1}}, {{2}} has sent you a quote for {{3}}, valid until {{4}}.\n\n" +
        `See the details and answer here: {{5}}\n\n${WA_SIGN_IN}`,
      params: (v) => [v.customerName, v.businessName, v.total, v.validUntil, v.link],
    },
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
      const headline =
        v.answer === "countered"
          ? "offered a different price"
          : v.answer === "accepted"
            ? "accepted your quote"
            : "turned down your quote";
      return {
        subject: `${v.customerName} ${headline} (${v.number})`,
        text: `${v.customerName} has ${quoteAnswer(v)} on request ${v.number}.\n\n${v.link}`,
      };
    },
    whatsapp: {
      name: "kaamkoti_quote_response",
      body: `On request {{1}}, {{2}} has {{3}}.\n\nOpen it: {{4}}\n\n${WA_OWNER_END}`,
      params: (v) => [v.number, v.customerName, quoteAnswer(v), v.link],
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
    whatsapp: {
      name: "kaamkoti_quote_expired",
      body:
        "Your quote of {{1}} to {{2}} on request {{3}} was not answered in time, so it can no longer be " +
        `accepted. Send a new one if the work is still wanted: {{4}}\n\n${WA_OWNER_END}`,
      params: (v) => [v.total, v.customerName, v.number, v.link],
    },
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
    whatsapp: {
      name: "kaamkoti_appointment_proposed",
      body:
        "Hello {{1}}, {{2}} can come to do the work on {{3}}. " +
        `Please confirm the time, or ask for another one: {{4}}\n\n${WA_SIGN_IN}`,
      params: (v) => [v.customerName, v.businessName, v.when, v.link],
    },
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
    whatsapp: {
      name: "kaamkoti_appointment_response",
      body: `On request {{1}}, {{2}} {{3}}.\n\nOpen it: {{4}}\n\n${WA_OWNER_END}`,
      params: (v) => [
        v.number,
        v.customerName,
        v.answer === "confirmed"
          ? `has confirmed the work on ${v.when}`
          : `cannot do ${v.when} and asks for another time${v.note ? `, saying "${v.note}"` : ""}`,
        v.link,
      ],
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
    whatsapp: {
      name: "kaamkoti_appointment_confirmed",
      body: `Hello {{1}}, {{2}} will come for a {{3}} on {{4}}.\n\nYour request: {{5}}\n\n${WA_SIGN_IN}`,
      params: (v) => [v.customerName, v.businessName, v.visit, v.when, v.link],
    },
  }),
  /** To the customer: the day before a planned visit. */
  "appointment.reminder": defineTemplate({
    vars: z.object({
      customerName: text,
      businessName: text,
      visit: z.enum(["work visit", "site visit"]),
      when: text,
      link,
    }),
    email: (v) => ({
      subject: `Tomorrow: ${v.businessName}, ${v.when}`,
      text:
        `Hello ${v.customerName},\n\n` +
        `A reminder that ${v.businessName} will come for a ${v.visit} on ${v.when}.\n\n` +
        `Your request:\n${v.link}\n\n${SIGN_IN}`,
    }),
    whatsapp: {
      name: "kaamkoti_appointment_reminder",
      body:
        "Hello {{1}}, a reminder that {{2}} will come for a {{3}} on {{4}}.\n\n" +
        `Your request: {{5}}\n\n${WA_SIGN_IN}`,
      params: (v) => [v.customerName, v.businessName, v.visit, v.when, v.link],
    },
  }),
  /** To the customer: the business has set out for the visit. */
  "appointment.on_the_way": defineTemplate({
    vars: z.object({ customerName: text, businessName: text, link }),
    email: (v) => ({
      subject: `${v.businessName} is on the way`,
      text:
        `Hello ${v.customerName},\n\n` +
        `${v.businessName} has set out and is on the way to you.\n\n` +
        `Your request:\n${v.link}\n\n${SIGN_IN}`,
    }),
    whatsapp: {
      name: "kaamkoti_appointment_on_the_way",
      body: `Hello {{1}}, {{2}} has set out and is on the way to you.\n\nYour request: {{3}}\n\n${WA_SIGN_IN}`,
      params: (v) => [v.customerName, v.businessName, v.link],
    },
  }),
  /**
   * To the owner: money reached their Razorpay account for a request, known from Razorpay's verified webhook.
   * `what` names it ("the deposit"); `amount` is this payment, which may be one part of several.
   */
  "payment.received": defineTemplate({
    vars: z.object({ customerName: text, number, amount: text, what: text, link }),
    email: (v) => ({
      subject: `${v.customerName} paid ${v.amount} (${v.number})`,
      text:
        `${v.customerName} has paid ${v.amount} towards ${v.what} on request ${v.number}. ` +
        `It is in your Razorpay account.\n\n${v.link}`,
    }),
    whatsapp: {
      name: "kaamkoti_payment_received",
      body:
        "Payment received: {{1}} paid {{2}} towards {{3}} on request {{4}}. It is in your Razorpay account.\n\n" +
        `Open it: {{5}}\n\n${WA_OWNER_END}`,
      params: (v) => [v.customerName, v.amount, v.what, v.number, v.link],
    },
  }),
  /**
   * To the owner, from platform itself: this month's WhatsApp messages ran out and a customer with no email got
   * nothing (architecture 9.2). `resumes` is the first day of next month ("1 December").
   */
  "notify.quota_used": defineTemplate({
    vars: z.object({ resumes: text }),
    email: (v) => ({
      subject: "This month's WhatsApp messages are used up",
      text:
        "Your business has used this month's WhatsApp messages. " +
        `Until ${v.resumes}, customers get their messages by email, and a customer who gave only a mobile ` +
        "number gets none: share the link to their request with them yourself.",
    }),
    whatsapp: {
      name: "kaamkoti_quota_used",
      body:
        "Your business has used this month's WhatsApp messages. Until {{1}}, customers get their messages " +
        "by email, and a customer who gave only a mobile number gets none: share the link to their request " +
        "with them yourself.",
      params: (v) => [v.resumes],
    },
  }),
};
