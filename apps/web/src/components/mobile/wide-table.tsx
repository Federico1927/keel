"use client";
import type * as React from "react";
import { useTranslations } from "next-intl";
import { ScrollTable } from "@hullwise/ui";

/** A wide analysis table that scrolls inside its own marked region on phones (#49, Tier 3), with the translated hint. */
export function WideTable(props: { label: string; stickyFirst?: boolean; wrapperClassName?: string } & React.TableHTMLAttributes<HTMLTableElement>) {
  const t = useTranslations("mobile.wide");
  return <ScrollTable hint={t("hint")} {...props} />;
}
