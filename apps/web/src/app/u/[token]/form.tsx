"use client";
import { useActionState } from "react";
import { Button } from "@hullwise/ui";
import { unsubscribeAction } from "@/server/actions/unsubscribe";

export function UnsubscribeForm({ token, labels }: { token: string; labels: { confirmTitle: string; confirm: string; button: string; doneTitle: string; done: string; invalid: string } }) {
  const [state, action, pending] = useActionState(unsubscribeAction.bind(null, token), null);
  if (state?.done) {
    return (
      <div data-testid="unsubscribed">
        <h1 className="mt-2 text-xl">{labels.doneTitle}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{labels.done}</p>
      </div>
    );
  }
  return (
    <form action={action}>
      <h1 className="mt-2 text-xl">{labels.confirmTitle}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{state && !state.done ? labels.invalid : labels.confirm}</p>
      <Button type="submit" className="mt-4" disabled={pending}>{labels.button}</Button>
    </form>
  );
}
