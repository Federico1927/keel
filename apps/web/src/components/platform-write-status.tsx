"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, cn } from "@keel/ui";
import { retryPlatformWriteAction } from "@/server/actions/platform-writes";

/** What the badge needs from a `platform_writes` row (see `latestPlatformWrites`). */
export interface PlatformWriteBadge {
  id: string;
  status: string;
  mode: string;
  attempts: number;
  lastError: string | null;
}

const VARIANT: Record<string, "success" | "warning" | "destructive" | "muted"> = { pending: "warning", running: "warning", succeeded: "success", failed: "destructive", superseded: "muted" };

/**
 * Sync state of a record's last platform write: nothing once synced (unless `showSynced`),
 * "Pending sync" while queued or retrying, "Sync failed" with the platform's error and a retry
 * button. Synchronous writes are re-run by their own flow, so they get no retry here.
 */
export function PlatformWriteStatus({ slug, write, canRetry = true, showSynced = false, showError = false, className }: { slug: string; write: PlatformWriteBadge | null | undefined; canRetry?: boolean; showSynced?: boolean; showError?: boolean; className?: string }) {
  const t = useTranslations("platform_writes");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!write || write.status === "superseded" || (write.status === "succeeded" && !showSynced)) return null;
  const retryable = canRetry && write.mode === "async" && (write.status === "failed" || write.status === "pending");
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)} data-testid="platform-write-status" data-status={write.status}>
      <Badge variant={VARIANT[write.status] ?? "muted"} title={write.lastError ?? undefined}>{t(`status.${write.status}`)}</Badge>
      {retryable && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await retryPlatformWriteAction(slug, write.id);
              setError(r.ok ? null : t("retry_failed"));
              router.refresh();
            })
          }
        >
          {t("retry")}
        </Button>
      )}
      {showError && write.status !== "succeeded" && write.lastError && <span className="max-w-xs truncate text-xs text-muted-foreground" title={write.lastError}>{write.lastError}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
