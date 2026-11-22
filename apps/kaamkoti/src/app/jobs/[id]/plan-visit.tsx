"use client";
import { useActionState } from "react";
import {
  type ConfirmVisitState,
  confirmVisitAction,
  type OnTheWayState,
  onTheWayAction,
  type PlanVisitState,
  planVisitAction,
} from "./actions.ts";

const LENGTHS = [
  [30, "30 minutes"],
  [60, "1 hour"],
  [120, "2 hours"],
  [180, "3 hours"],
  [240, "4 hours"],
  [480, "A full day"],
] as const;

export function PlanVisit({
  jobId,
  workable,
  team,
}: {
  jobId: string;
  /** The quote is accepted, so the work itself can be planned and not only a site visit. */
  workable: boolean;
  team: readonly { readonly id: string; readonly name: string }[];
}) {
  const [state, action, pending] = useActionState<PlanVisitState, FormData>(planVisitAction, {});
  return (
    <form action={action} className="card">
      <input type="hidden" name="jobId" value={jobId} />
      <label>
        What
        <select name="kind" defaultValue={workable ? "work" : "site_visit"}>
          {workable ? <option value="work">The work</option> : null}
          <option value="site_visit">Site visit</option>
        </select>
      </label>
      <label>
        Who
        <select name="technicianId" defaultValue={team[0]?.id}>
          {team.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Starts
        <input name="start" type="datetime-local" required />
      </label>
      <label>
        Takes
        <select name="minutes" defaultValue="60">
          {LENGTHS.map(([minutes, label]) => (
            <option key={minutes} value={minutes}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {workable ? (
        <p className="muted small">
          The work's time goes to the customer to confirm; a site visit is planned at once.
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Planning…" : "Plan it"}
      </button>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** Tells the customer the owner has set out for the visit. */
export function OnTheWay({ jobId, appointmentId }: { jobId: string; appointmentId: string }) {
  const [state, action, pending] = useActionState<OnTheWayState, FormData>(onTheWayAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <button type="submit" className="quiet" disabled={pending}>
        {pending ? "Telling them…" : "I'm on my way"}
      </button>
      {state.sent ? (
        <p className="notice" role="status">
          The customer has been told.
        </p>
      ) : null}
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** For a customer who agreed to the proposed time by phone: the owner confirms it for them. */
export function ConfirmForCustomer({
  jobId,
  appointmentId,
}: {
  jobId: string;
  appointmentId: string;
}) {
  const [state, action, pending] = useActionState<ConfirmVisitState, FormData>(
    confirmVisitAction,
    {},
  );
  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <button type="submit" className="quiet" disabled={pending}>
        {pending ? "Confirming…" : "They agreed by phone: confirm"}
      </button>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
