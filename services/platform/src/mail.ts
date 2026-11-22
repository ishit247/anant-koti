// Email over SMTP (Mailpit in development). Sign-in codes go out here directly, not through notify's queue: a code
// that waits for a retry is useless, and the person is on the sign-in page to ask for another.
import nodemailer from "nodemailer";
import type { SendCode } from "./identity.ts";
import type { SendEmail } from "./notify.ts";

/** Awaited, so a mail failure fails the caller instead of vanishing. */
export function emailSender(smtpUrl: string, from: string): SendEmail {
  const transport = nodemailer.createTransport(smtpUrl);
  return async ({ to, subject, text }) => {
    await transport.sendMail({ from, to, subject, text });
  };
}

export function codeMailer(sendEmail: SendEmail): SendCode {
  return (to, code) =>
    sendEmail({
      to: to.email,
      subject: `${code} is your sign-in code`,
      text:
        `Your sign-in code is ${code}.\n\n` +
        "It works once and expires in 10 minutes. If you did not ask for it, ignore this email: " +
        "nobody can sign in without the code.",
    });
}
