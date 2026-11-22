import type { z } from "zod";

export interface Email {
  readonly subject: string;
  readonly text: string;
}

/**
 * A WhatsApp version: a template Meta has approved, sent by name with its body's parameters in order. `body` is
 * the text submitted to Meta for approval, with `{{1}}`, `{{2}}`… where the parameters go; it is kept here so
 * the two cannot drift unseen (a test checks each body takes as many parameters as `params` gives).
 */
export interface WhatsApp<V> {
  readonly name: string;
  readonly body: string;
  params(vars: V): readonly string[];
}

/** One message type of a product: the variables it takes, and its text on each channel it has. */
export interface Template<V> {
  readonly vars: z.ZodType<V>;
  email(vars: V): Email;
  /** Absent for a message that goes by email only. */
  readonly whatsapp?: WhatsApp<V>;
}

/** Ties the renderers' argument to the schema's type. */
export const defineTemplate = <V>(template: Template<V>): Template<V> => template;
