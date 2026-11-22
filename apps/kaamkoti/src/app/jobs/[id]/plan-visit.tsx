"use client";
import { useActionState } from "react";
import { type PlanVisitState, planVisitAction } from "./actions.ts";

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
