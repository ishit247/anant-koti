import type { z } from "zod";

export interface Email {
  readonly subject: string;
  readonly text: string;
}

/** One message type of a product: the variables it takes, and its text on each channel it has. */
export interface Template<V> {
  readonly vars: z.ZodType<V>;
  email(vars: V): Email;
}

/** Ties the renderer's argument to the schema's type. */
export const defineTemplate = <V>(template: Template<V>): Template<V> => template;
