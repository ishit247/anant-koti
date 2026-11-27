"use client";
import { useActionState, useState, useTransition } from "react";
import type { ChecklistResult } from "../../../work.ts";
import {
  checkInAction,
  completeAction,
  foundWorkAction,
  tickAction,
  type WorkState,
} from "./actions.ts";

function Refusal({ state }: { state: WorkState }) {
  return state.error ? (
    <p className="error" role="alert">
      {state.error}
    </p>
  ) : null;
}

/** The main action before the work starts. */
export function CheckIn({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<WorkState, FormData>(checkInAction, {});
  return (
    <form action={action} className="dock">
      <input type="hidden" name="jobId" value={jobId} />
      <Refusal state={state} />
      <button type="submit" disabled={pending}>
        {pending ? "Checking in…" : "Check in"}
      </button>
      <p className="muted small">Tells the office you are on site.</p>
    </form>
  );
}

/** Each tick saves the whole set as it stands; without JavaScript, Save posts the lot. */
export function Checklist({
  jobId,
  items,
  editable,
}: {
  jobId: string;
  items: ChecklistResult;
  editable: boolean;
}) {
  const [state, action, pending] = useActionState<WorkState, FormData>(tickAction, {});
  // Held here rather than in the inputs: React resets a form after its action, which would untick them.
  const [done, setDone] = useState(() => new Set(items.filter((i) => i.done).map((i) => i.key)));
  const [, startTransition] = useTransition();
  const tick = (key: string, checked: boolean) => {
    const next = new Set(done);
    if (checked) next.add(key);
    else next.delete(key);
    setDone(next);
    const form = new FormData();
    form.set("jobId", jobId);
    for (const k of next) form.append("done", k);
    startTransition(() => action(form));
  };
  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />
      <div className="choices">
        {items.map((item) => (
          <label key={item.key} className="choice place">
            <input
              type="checkbox"
              name="done"
              value={item.key}
              checked={done.has(item.key)}
              disabled={!editable}
              onChange={(event) => tick(item.key, event.currentTarget.checked)}
            />
            <span>{item.label}</span>
          </label>
        ))}
      </div>
      {editable ? (
        <noscript>
          <button type="submit" className="quiet">
            Save the checklist
          </button>
        </noscript>
      ) : null}
      <Refusal state={state} />
      {state.saved && !pending ? (
        <p className="muted small" role="status">
          Saved.
        </p>
      ) : null}
    </form>
  );
}

/**
 * Extra work found on site (4.3). It is not to be done yet: the owner prices it and the customer approves it
 * first. Behind a tap, so the sheet stays short.
 */
export function FoundWork({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<WorkState, FormData>(foundWorkAction, {});
  return (
    <details className="card">
      <summary>Found more work?</summary>
      <form action={action} className="stack">
        <input type="hidden" name="jobId" value={jobId} />
        <label>
          What needs doing
          <input name="title" required maxLength={120} autoComplete="off" />
        </label>
        <label>
          Details (optional)
          <textarea name="details" maxLength={1000} rows={3} />
        </label>
        <Refusal state={state} />
        {state.saved ? (
          <p className="muted small" role="status">
            Added. The office prices it for the customer to approve; wait for that before doing it.
          </p>
        ) : null}
        <button type="submit" className="quiet" disabled={pending}>
          {pending ? "Adding…" : "Add for approval"}
        </button>
      </form>
    </details>
  );
}

/** The main action once the work is under way. */
export function Complete({ jobId, open }: { jobId: string; open: number }) {
  const [state, action, pending] = useActionState<WorkState, FormData>(completeAction, {});
  return (
    <form action={action} className="stack">
      <input type="hidden" name="jobId" value={jobId} />
      <label>
        Note for the office (optional)
        <textarea name="note" maxLength={1000} rows={3} placeholder="Replaced the capacitor" />
      </label>
      <div className="dock stacked">
        <Refusal state={state} />
        <button type="submit" disabled={pending}>
          {pending ? "Completing…" : "Mark complete"}
        </button>
        <p className="muted small">
          {open > 0
            ? `${open} checklist ${open === 1 ? "item is" : "items are"} not ticked.`
            : "The job is marked done for the office."}
        </p>
      </div>
    </form>
  );
}
