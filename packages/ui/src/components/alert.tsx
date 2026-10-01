import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

const alertVariants = cva("relative w-full rounded-lg border p-4 text-sm [&>svg~*]:pl-7 [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4", {
  variants: {
    variant: {
      default: "bg-card text-foreground",
      destructive: "border-destructive/50 text-destructive [&>svg]:text-destructive",
      warning: "border-warning/50 bg-warning/10 text-foreground [&>svg]:text-warning",
      info: "border-info/40 bg-info/10",
    },
  },
  defaultVariants: { variant: "default" },
});

export const Alert = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>>(
  ({ className, variant, ...props }, ref) => <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />,
);
Alert.displayName = "Alert";
export const AlertTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h5 className={cn("mb-1 font-medium leading-none tracking-tight", className)} {...props} />
);
export const AlertDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <div className={cn("text-sm [&_p]:leading-relaxed", className)} {...props} />
);
