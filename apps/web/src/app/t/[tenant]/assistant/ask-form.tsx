"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Send, Trash2 } from "lucide-react";
import { Button, Textarea } from "@keel/ui";
import { askAssistantAction, deleteAssistantThreadAction } from "@/server/actions/assistant";

const MAX_CHARS = 2000;

export function AskForm({ slug, threadId, suggestions }: { slug: string; threadId: string | null; suggestions: string[] }) {
  const t = useTranslations("assistant");
  const tc = useTranslations("common");
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const ask = (q: string) => {
    const text = q.trim();
    if (!text || pending) return;
    setError(null);
    setAsked(text);
    start(async () => {
      const r = await askAssistantAction(slug, threadId, text);
      if (!r.ok) {
        setError(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : tc(`errors.${r.error}`));
        return;
      }
      setQuestion("");
      setAsked(null);
      if (r.data!.threadId !== threadId) router.push(`/t/${slug}/assistant?thread=${r.data!.threadId}`);
      else router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      {pending && asked && (
        <div className="space-y-2" data-testid="assistant-pending">
          <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary/80 px-4 py-2 text-sm text-primary-foreground">{asked}</div>
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t("thinking")}</p>
        </div>
      )}
      {suggestions.length > 0 && !pending && (
        <div className="flex flex-wrap gap-2" data-testid="assistant-suggestions">
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => ask(s)} className="rounded-full border bg-card px-3 py-1 text-left text-xs hover:bg-muted disabled:opacity-50">{s}</button>
          ))}
        </div>
      )}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <label htmlFor="assistant-question" className="sr-only">{t("ask_label")}</label>
        <Textarea
          id="assistant-question"
          data-testid="assistant-input"
          value={question}
          maxLength={MAX_CHARS}
          rows={3}
          disabled={pending}
          placeholder={threadId ? t("follow_up_placeholder") : t("placeholder")}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              ask(question);
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
          <Button type="submit" size="sm" disabled={pending || !question.trim()} data-testid="assistant-ask">
            {pending ? <Loader2 className="animate-spin" /> : <Send />} {t("ask")}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive" data-testid="assistant-form-error">{error}</p>}
      </form>
    </div>
  );
}

export function DeleteThreadButton({ slug, threadId }: { slug: string; threadId: string }) {
  const t = useTranslations("assistant");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      data-testid="assistant-delete"
      onClick={() => {
        if (!window.confirm(t("delete_confirm"))) return;
        start(async () => {
          const r = await deleteAssistantThreadAction(slug, threadId);
          if (r.ok) router.push(`/t/${slug}/assistant`);
        });
      }}
    >
      <Trash2 /> {t("delete")}
    </Button>
  );
}
