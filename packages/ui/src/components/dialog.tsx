"use client";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay ref={ref} className={cn("fixed inset-0 z-50 bg-overlay backdrop-blur-[1px]", className)} {...props} />
));
DialogOverlay.displayName = "DialogOverlay";

/**
 * `side="center"` is a centred dialog from `sm` up and a bottom sheet on phones (full width, docked
 * to the bottom, scrolls inside, clears the home bar); `side="bottom"` is a sheet at every width;
 * `side="right"` a drawer. `mobile="fullscreen"` turns the phone sheet into a full-screen page (search).
 */
export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: "center" | "right" | "bottom"; mobile?: "sheet" | "fullscreen"; closeLabel?: string }
>(({ className, children, side = "center", mobile = "sheet", closeLabel = "Close", ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed z-50 grid w-full gap-4 border bg-card p-6 shadow-lg",
        side === "center" &&
          (mobile === "fullscreen"
            ? "inset-0 h-dvh max-h-dvh overflow-y-auto rounded-none border-0 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[90dvh] sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border sm:pb-6 sm:pt-6"
            : "inset-x-0 bottom-0 mx-auto max-h-[92dvh] max-w-lg overflow-y-auto rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:mx-0 sm:max-h-[90dvh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:pb-6"),
        side === "bottom" && "inset-x-0 bottom-0 mx-auto max-h-[92dvh] max-w-lg overflow-y-auto rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]",
        side === "right" && "right-0 top-0 h-full max-w-md overflow-y-auto",
        className,
      )}
      {...props}
    >
      {side !== "right" && mobile === "sheet" && <span aria-hidden className={cn("mx-auto -mt-3 mb-1 block h-1 w-10 rounded-full bg-muted-foreground/30", side === "center" && "sm:hidden")} />}
      {children}
      <DialogPrimitive.Close className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring pointer-coarse:h-11 pointer-coarse:w-11">
        <X className="h-4 w-4" />
        <span className="sr-only">{closeLabel}</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = "DialogContent";

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-left", className)} {...props} />
);
export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-0 sm:space-x-2", className)} {...props} />
);
export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";
export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = "DialogDescription";
