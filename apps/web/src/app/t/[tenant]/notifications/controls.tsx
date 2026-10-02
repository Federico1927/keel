"use client";
import { useTransition } from "react";
import { Check, CheckCheck, Undo2 } from "lucide-react";
import { Button } from "@hullwise/ui";
import { markNotificationsRead, setMentionsReadAction, setNotificationsReadAction } from "@/server/actions/notifications";

export function ReadToggle({ slug, id, read, labels, kind = "notification" }: { slug: string; id: string; read: boolean; labels: { read: string; unread: string }; kind?: "notification" | "mention" }) {
  const [pending, start] = useTransition();
  const label = read ? labels.unread : labels.read;
  return (
    <Button variant="ghost" size="sm" disabled={pending} className="self-start" aria-label={label} title={label} data-testid="read-toggle" onClick={() => start(async () => void (kind === "mention" ? await setMentionsReadAction(slug, [id], !read) : await setNotificationsReadAction(slug, [id], !read)))}>
      {read ? <Undo2 className="h-4 w-4" /> : <Check className="h-4 w-4" />}
      <span className="sm:hidden">{label}</span>
    </Button>
  );
}

export function MarkAllButton({ slug, label, kind = "notification" }: { slug: string; label: string; kind?: "notification" | "mention" }) {
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => start(async () => void (kind === "mention" ? await setMentionsReadAction(slug, "all", true) : await markNotificationsRead(slug)))}>
      <CheckCheck className="h-4 w-4" /> {label}
    </Button>
  );
}
