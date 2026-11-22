import type { JobStatus } from "../../../../../job.ts";
import { formatTime, formatWhen } from "../../../../../job-labels.ts";
import type { WorkTime } from "../../../../../schedule.ts";

/** What ./visit reports back, by `?visit=`; success is a status, anything else an alert. */
const ANSWERED: Record<string, (business: string) => string> = {
  confirm: (b) => `Thank you. The time is confirmed; ${b} will come then.`,
  decline: (b) => `${b} will propose another time.`,
};
const REFUSED: Record<string, (business: string) => string> = {
  input: () => "A note can be up to 500 characters.",
  answered: (b) => `This time has already been answered, or ${b} proposed a newer one.`,
  closed: () => "This request no longer takes an answer to its time.",
};
const TRY_AGAIN = () => "That did not work. Please try again.";

/**
 * The work's time on the customer's request page (3.1b): the proposed time with Confirm and "Ask for another
 * time" (plain forms, posting to `action`), the time they asked to change, or the confirmed visit.
 */
export function VisitAnswer({
  work,
  status,
  businessName,
  action,
  said,
}: {
  work: WorkTime;
  status: JobStatus;
  businessName: string;
  action: string;
  said: string | undefined;
}) {
  const when = `${formatWhen(work.startsAt)} to ${formatTime(work.endsAt)}`;
  const open = work.status === "proposed" && status === "accepted";
  return (
    <section className="panel">
      <h2>
        {work.status === "planned" || work.status === "done" ? "Work visit" : "Time for the work"}
      </h2>
      {said && ANSWERED[said] ? (
        <p role="status" className="notice">
          {ANSWERED[said](businessName)}
        </p>
      ) : said ? (
        <p role="alert" className="error">
          {(REFUSED[said] ?? TRY_AGAIN)(businessName)}
        </p>
      ) : null}
      {work.status === "declined" ? (
        <p className="muted small">
          You asked for another time than {when}
          {work.note ? `: "${work.note}"` : "."} Waiting for {businessName} to propose one.
        </p>
      ) : (
        <p>
          <strong>{when}</strong>
        </p>
      )}
      {open ? (
        <>
          <p className="muted small">{businessName} proposes this time. Does it suit you?</p>
          <form method="post" action={action}>
            <input type="hidden" name="appointment" value={work.id} />
            <button type="submit" name="answer" value="confirm">
              Confirm this time
            </button>
          </form>
          <details className="card">
            <summary>Ask for another time</summary>
            <form method="post" action={action}>
              <input type="hidden" name="appointment" value={work.id} />
              <input type="hidden" name="answer" value="decline" />
              <label>
                What suits you better? (optional)
                <textarea name="note" maxLength={500} rows={3} />
              </label>
              <button type="submit" className="quiet">
                Ask for another time
              </button>
            </form>
          </details>
        </>
      ) : null}
    </section>
  );
}
