"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Textarea } from "@hullwise/ui";
import { decideProposalAction } from "@/server/actions/mcp";

/** Approve (runs the action as you) or reject a proposal, with an optional note. */
export function ProposalActions({ slug, id }: { slug: string; id: string }) {
  const t = useTranslations("mcp.approvals");
  const te = useTranslations("mcp.errors");
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const decide = (decision: "approve" | "reject") =>
    start(async () => {
      const r = await decideProposalAction(slug, id, decision, note);
      if (!r.ok) setMessage(te.has(r.error) ? te(r.error) : te("generic"));
      else if (r.data?.status === "failed") setMessage(t("failed", { error: r.data.error ?? "" }));
      else setMessage(null);
      router.refresh();
    });
  return (
    <div className="space-y-2">
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder={t("note_placeholder")} aria-label={t("note_placeholder")} />
      <div className="flex flex-wrap justify-end gap-2 max-sm:[&>button]:flex-1">
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => decide("reject")} data-testid="proposal-reject">{t("reject")}</Button>
        <Button type="button" size="sm" disabled={pending} onClick={() => { if (window.confirm(t("approve_confirm"))) decide("approve"); }} data-testid="proposal-approve">{t("approve")}</Button>
      </div>
      {message && <p className="text-xs text-destructive">{message}</p>}
    </div>
  );
}
