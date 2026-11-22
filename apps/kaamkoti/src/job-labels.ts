// How the owner's pages name a job's state and source, and show when it arrived.
import type { JobSource } from "./inbox.ts";
import type { JobStatus } from "./job.ts";
import type { Quote, QuoteStatus } from "./quote.ts";

export const STATUS_LABEL: Record<JobStatus, string> = {
  requested: "New",
  quoted: "Quoted",
  accepted: "Accepted",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  declined: "Declined",
  lost: "Lost",
  cancelled: "Cancelled",
};

/** The chip colour: new work stands out, work moving on is green, waiting on the customer is amber. */
export function statusTone(status: JobStatus): "new" | "go" | "wait" | "" {
  if (status === "requested") return "new";
  if (status === "accepted" || status === "scheduled" || status === "in_progress") return "go";
  if (status === "quoted") return "wait";
  return "";
}

/** A quote's state as the owner reads it; a sent quote past its validity reads "Expired". */
export function quoteLabel(quote: Pick<Quote, "status" | "expired">): string {
  if (quote.expired) return "Expired";
  return QUOTE_LABEL[quote.status];
}

const QUOTE_LABEL: Record<QuoteStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  countered: "Counter-offer",
  superseded: "Replaced",
};

export const SOURCE_LABEL: Record<JobSource, string> = {
  public_form: "Web form",
  whatsapp_link: "WhatsApp link",
  qr: "QR code",
  phone: "Phone",
};

const WHEN = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

export const formatWhen = (date: Date) => WHEN.format(date);

const DAY = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

export const formatDay = (date: Date) => DAY.format(date);
