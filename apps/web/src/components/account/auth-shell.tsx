import type { ReactNode } from "react";
import { PRODUCT_NAME } from "@keel/config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@keel/ui";
import { BrandMark } from "@/components/brand-mark";
import { LocaleSwitcher } from "@/components/locale-switcher";

/** Signed-out account pages (#52: invitation, forgotten password, reset): mark, language and one card, mobile first. */
export function AuthShell({ title, description, children, testId }: { title: string; description?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-background px-4 py-8 sm:items-center sm:py-10">
      <div className="w-full max-w-md space-y-6" data-testid={testId}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <span className="text-sm font-semibold">{PRODUCT_NAME}</span>
          </div>
          <LocaleSwitcher />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}
