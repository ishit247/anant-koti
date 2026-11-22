// Kaam Koti's message templates (docs/architecture.md 9.2), one version per channel. Variables arrive as display
// text the app formatted; a template only places them. WhatsApp versions join in 3.3, mirroring Meta's approved
// templates.
import { z } from "zod";
import { defineTemplate } from "./template.ts";

const text = z.string().min(1).max(200);

export const kaamkoti = {
  "quote.sent": defineTemplate({
    vars: z.object({
      customerName: text,
      businessName: text,
      total: text,
      validUntil: text,
      link: z.url({ protocol: /^https?$/ }),
    }),
    email: (v) => ({
      subject: `Your quote from ${v.businessName}: ${v.total}`,
      text:
        `Hello ${v.customerName},\n\n` +
        `${v.businessName} has sent you a quote for ${v.total}, valid until ${v.validUntil}.\n\n` +
        `See the details and answer here:\n${v.link}\n\n` +
        "You do not need an account. Keep this email: the link is only for you.",
    }),
  }),
};
