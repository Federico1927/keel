import { canWritePage } from "@hullwise/config";
import { listRecordNotes, type RecordNoteType } from "@hullwise/services";
import { getTenantContext } from "@/server/tenant";
import { tenantPeople } from "@/server/people";
import { RecordNotesPanel } from "./record-notes-panel";

/**
 * Internal notes with @mentions for purchase orders and returns (orders have their own panel).
 * Self-contained: one line in the record page, `<RecordNotes slug={tenant} type="purchase_order" id={po.id} />`.
 */
export async function RecordNotes({ slug, type, id }: { slug: string; type: RecordNoteType; id: string }) {
  const ctx = await getTenantContext(slug);
  const [notes, people] = await Promise.all([ctx.run((tx) => listRecordNotes({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, type, id)), tenantPeople(ctx)]);
  return (
    <RecordNotesPanel
      slug={slug}
      entityType={type}
      entityId={id}
      currentUserId={ctx.user.id}
      isAdmin={ctx.role === "owner" || ctx.role === "admin"}
      canWrite={canWritePage(ctx.role, type === "purchase_order" ? "purchasing" : "returns")}
      people={people.map((p) => ({ id: p.id, name: p.name }))}
      notes={notes.map(({ n, authorName, authorEmail }) => ({ id: n.id, authorId: n.authorId, authorName: authorName ?? authorEmail ?? "—", body: n.body, at: n.createdAt.toISOString() }))}
      locale={ctx.locale}
      timezone={ctx.tenant.timezone}
    />
  );
}
