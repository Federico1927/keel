import { Paperclip } from "lucide-react";
import { cn } from "@keel/ui";

export interface ThreadMessage {
  id: string;
  side: string;
  author: string;
  body: string;
  at: string;
  attachment: { name: string; href: string } | null;
}

/** Conversation of a support ticket, shared by the tenant page and the console. */
export function SupportThread({ messages, downloadLabel, platformRight = false }: { messages: ThreadMessage[]; downloadLabel: string; platformRight?: boolean }) {
  return (
    <ol className="space-y-3" data-testid="support-thread">
      {messages.map((m) => {
        const right = platformRight ? m.side === "platform" : m.side === "tenant";
        return (
          <li key={m.id} className={cn("max-w-[42rem] rounded-lg border p-3 text-sm", right ? "ml-auto bg-primary/5" : "bg-card")} data-testid="support-message">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{m.author}</span>
              <span>{m.at}</span>
            </div>
            <p className="whitespace-pre-wrap">{m.body}</p>
            {m.attachment && (
              <a href={m.attachment.href} className="mt-2 inline-flex items-center gap-1 text-xs underline" title={downloadLabel}>
                <Paperclip className="h-3.5 w-3.5" /> {m.attachment.name}
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );
}
