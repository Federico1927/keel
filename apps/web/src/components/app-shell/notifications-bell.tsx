"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bell } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@hullwise/ui";
import { formatRelative } from "@hullwise/core";
import { markNotificationsRead } from "@/server/actions/notifications";
import { notificationText } from "@/components/notification-text";

export interface BellItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: string;
  readAt: string | null;
  createdAt: string;
}

export function NotificationsBell({
  slug,
  unread,
  items,
  locale,
}: {
  slug: string;
  unread: number;
  items: BellItem[];
  locale: string;
}) {
  const t = useTranslations("notifications");
  const router = useRouter();
  const [, start] = useTransition();
  return (
    <DropdownMenu
      onOpenChange={(open) => open && unread > 0 && start(() => markNotificationsRead(slug))}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("title")} className="relative">
          <Bell />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>{t("title")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 && (
          <p className="px-2 py-4 text-center text-sm text-muted-foreground">{t("empty")}</p>
        )}
        {/* the list scrolls inside the menu so "View all" stays on screen however many items there are */}
        <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
          {items.map((n) => {
            const text = notificationText(t, n);
            return (
              <DropdownMenuItem
                key={n.id}
                className={`flex-col items-start gap-0.5 ${n.readAt ? "opacity-70" : ""}`}
                onSelect={() =>
                  n.link && router.push(n.link.startsWith("/t/") ? n.link : `/t/${slug}${n.link}`)
                }
              >
                <span className="text-sm font-medium">{text.title}</span>
                {text.body && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">{text.body}</span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {formatRelative(n.createdAt, locale)}
                </span>
              </DropdownMenuItem>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => router.push(`/t/${slug}/notifications`)}
          className="justify-center text-sm font-medium"
          data-testid="bell-view-all"
        >
          {t("view_all")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
