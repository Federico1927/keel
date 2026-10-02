"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, type ButtonProps } from "@hullwise/ui";

/**
 * A confirmation in the app's dialog, a bottom sheet on phones (#49), in place of `window.confirm`:
 * controlled (`open`, `onOpenChange`) for a button that already exists.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm, destructive, pending, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; confirmLabel: string; onConfirm: () => void; destructive?: boolean; pending?: boolean; children?: React.ReactNode }) {
  const tc = useTranslations("common");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="confirm-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{tc("cancel")}</Button>
          <Button type="button" variant={destructive ? "destructive" : "default"} disabled={pending} onClick={() => { onOpenChange(false); onConfirm(); }} data-testid="confirm-accept">{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A button that asks first: the trigger keeps its props (test id, label, variant); the action runs on confirm. */
export function ConfirmButton({ title, description, confirmLabel, onConfirm, destructive, children, ...props }: { title: string; description?: string; confirmLabel: string; onConfirm: () => void; destructive?: boolean } & Omit<ButtonProps, "onClick">) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" {...props} onClick={() => setOpen(true)}>{children}</Button>
      <ConfirmDialog open={open} onOpenChange={setOpen} title={title} description={description} confirmLabel={confirmLabel} onConfirm={onConfirm} destructive={destructive} pending={props.disabled ?? undefined} />
    </>
  );
}
