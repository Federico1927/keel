"use client";
import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Textarea } from "@keel/ui";
import { formatDateTime, mentionQueryAtCaret, tokenizeMentions } from "@keel/core";
import { addRecordNoteAction, removeRecordNoteAction } from "@/server/actions/notes";

interface Note { id: string; authorId: string | null; authorName: string; body: string; at: string }

export function RecordNotesPanel({ slug, entityType, entityId, currentUserId, isAdmin, canWrite, people, notes, locale, timezone }: { slug: string; entityType: string; entityId: string; currentUserId: string; isAdmin: boolean; canWrite: boolean; people: { id: string; name: string }[]; notes: Note[]; locale: string; timezone: string }) {
  const t = useTranslations("record_notes");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);
  const suggestions = query ? people.filter((p) => p.id !== currentUserId && p.name.toLowerCase().includes(query.query.toLowerCase())).slice(0, 6) : [];
  const insertMention = (p: { id: string; name: string }) => {
    if (!query) return;
    const caret = ref.current?.selectionStart ?? body.length;
    setBody(`${body.slice(0, query.start)}@[${p.name}](${p.id}) ${body.slice(caret)}`);
    setQuery(null);
    ref.current?.focus();
  };
  return (
    <Card data-testid="record-notes">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canWrite && (
          <div className="relative space-y-2">
            <Textarea ref={ref} value={body} rows={3} placeholder={t("placeholder")} aria-label={t("title")} onChange={(e) => { setBody(e.target.value); setQuery(mentionQueryAtCaret(e.target.value, e.target.selectionStart)); }} onKeyUp={(e) => setQuery(mentionQueryAtCaret(e.currentTarget.value, e.currentTarget.selectionStart))} />
            {suggestions.length > 0 && (
              <ul className="absolute z-10 mt-1 w-64 rounded-md border bg-popover p-1 shadow-md" role="listbox">
                {suggestions.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="w-full rounded-sm px-2 py-1 text-left text-sm hover:bg-muted" onMouseDown={(e) => { e.preventDefault(); insertMention(p); }}>
                      @{p.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{t("hint")}</p>
              <Button size="sm" disabled={pending || !body.trim()} onClick={() => start(async () => { const r = await addRecordNoteAction(slug, entityType, entityId, body); if (r.ok) setBody(""); })}>
                {t("add")}
              </Button>
            </div>
          </div>
        )}
        <ul className="space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border p-3 text-sm" data-testid="record-note">
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span><span className="font-medium text-foreground">{n.authorName}</span> · {formatDateTime(n.at, locale, timezone)}</span>
                {canWrite && (isAdmin || n.authorId === currentUserId) && (
                  <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={t("delete")} disabled={pending} onClick={() => start(async () => void (await removeRecordNoteAction(slug, entityType, entityId, n.id)))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              <p className="whitespace-pre-wrap">
                {tokenizeMentions(n.body).map((tok, i) => (tok.type === "text" ? <span key={i}>{tok.value}</span> : <span key={i} className="rounded bg-accent px-1 text-accent-foreground">@{tok.label}</span>))}
              </p>
            </li>
          ))}
          {notes.length === 0 && <li className="text-sm text-muted-foreground">{t("empty")}</li>}
        </ul>
      </CardContent>
    </Card>
  );
}
