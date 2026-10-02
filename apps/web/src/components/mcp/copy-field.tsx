"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Copy } from "lucide-react";
import { Button } from "@hullwise/ui";

/** A value to copy (server URL, a token shown once): monospace, wraps on phones. */
export function CopyField({ value, testId }: { value: string; testId?: string }) {
  const t = useTranslations("mcp");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs" data-testid={testId}>{value}</code>
      <Button type="button" size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); }}>
        <Copy /> {copied ? t("copied") : t("copy")}
      </Button>
    </div>
  );
}
