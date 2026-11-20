// Sign-in codes by email over SMTP (Mailpit in development). Notify (3.2) takes over delivery; until then this is
// the one message platform sends.
import nodemailer from "nodemailer";
import type { SendCode } from "./identity.ts";

/** Awaited, so a mail failure fails the request instead of vanishing. */
export function codeMailer(smtpUrl: string, from: string): SendCode {
  const transport = nodemailer.createTransport(smtpUrl);
  return async (to, code) => {
    await transport.sendMail({
      from,
      to: to.email,
      subject: `${code} is your sign-in code`,
      text:
        `Your sign-in code is ${code}.\n\n` +
        "It works once and expires in 10 minutes. If you did not ask for it, ignore this email: " +
        "nobody can sign in without the code.",
    });
  };
}
