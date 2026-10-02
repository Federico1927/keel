"use client";
import * as React from "react";
import { Maximize2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, cn } from "@hullwise/ui";

/**
 * A chart with a "full screen" button below `lg` (#49, Tier 3): the same chart opens in a sheet that
 * fills the screen, so turning the phone sideways gives it the whole width. The chart's own height is
 * overridden to fill the sheet (Recharts' ResponsiveContainer follows its parent).
 */
export function ChartFullscreen({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  const t = useTranslations("mobile.chart");
  const tm = useTranslations("mobile");
  const [open, setOpen] = React.useState(false);
  return (
    <div className={cn("relative", className)}>
      <div className="mb-1 flex justify-end lg:hidden">
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => setOpen(true)} data-testid="chart-fullscreen">
          <Maximize2 className="h-3.5 w-3.5" aria-hidden /> {t("fullscreen")}
        </Button>
      </div>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent mobile="fullscreen" closeLabel={tm("close")} className="flex flex-col gap-2 p-4 sm:inset-0 sm:h-dvh sm:max-h-dvh sm:max-w-none sm:translate-x-0 sm:translate-y-0 sm:rounded-none sm:border-0" data-testid="chart-fullscreen-sheet">
          <DialogHeader className="pr-10">
            <DialogTitle className="text-base">{title}</DialogTitle>
            <DialogDescription className="text-xs landscape:hidden">{t("rotate")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 [&>*]:h-full!">{open && children}</div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
