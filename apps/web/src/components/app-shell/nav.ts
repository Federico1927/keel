import type { MobileNavKey, PageKey } from "@hullwise/config";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bell,
  LifeBuoy,
  ListChecks,
  MessageCircle,
  Boxes,
  CalendarRange,
  ClipboardCheck,
  Inbox,
  ClipboardList,
  Contact,
  Gauge,
  Megaphone,
  Package,
  PackageCheck,
  PhoneCall,
  Plug,
  Repeat,
  RotateCcw,
  ScrollText,
  Settings,
  Sparkles,
  ShoppingBag,
  Tag,
  Truck,
  Users,
  Workflow,
} from "lucide-react";

export interface NavItem {
  page: PageKey;
  href: string;
  labelKey: string;
  icon: LucideIcon;
}
export interface NavSection {
  labelKey: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    labelKey: "nav.sections.operations",
    items: [
      { page: "dashboard", href: "", labelKey: "nav.dashboard", icon: Gauge },
      { page: "orders", href: "/orders", labelKey: "nav.orders", icon: ShoppingBag },
      { page: "shipments", href: "/fulfilment", labelKey: "nav.fulfilment", icon: PackageCheck },
      { page: "shipments", href: "/shipments", labelKey: "nav.shipments", icon: Truck },
      { page: "returns", href: "/returns", labelKey: "nav.returns", icon: RotateCcw },
      { page: "tasks", href: "/tasks", labelKey: "nav.tasks", icon: ListChecks },
      { page: "cod_queue", href: "/cod", labelKey: "nav.cod_queue", icon: PhoneCall },
    ],
  },
  {
    labelKey: "nav.sections.catalog",
    items: [
      { page: "products", href: "/products", labelKey: "nav.products", icon: Package },
      { page: "inventory", href: "/inventory", labelKey: "nav.inventory", icon: Boxes },
      { page: "inventory", href: "/inventory/planning", labelKey: "nav.planning", icon: CalendarRange },
      { page: "purchasing", href: "/purchasing", labelKey: "nav.purchasing", icon: ClipboardList },
    ],
  },
  {
    labelKey: "nav.sections.growth",
    items: [
      { page: "assistant", href: "/assistant", labelKey: "nav.assistant", icon: Sparkles },
      { page: "analytics", href: "/analytics", labelKey: "nav.analytics", icon: BarChart3 },
      { page: "campaigns", href: "/campaigns", labelKey: "nav.campaigns", icon: Megaphone },
      { page: "customers", href: "/customers", labelKey: "nav.customers", icon: Contact },
      { page: "subscriptions", href: "/subscriptions", labelKey: "nav.subscriptions", icon: Repeat },
      { page: "segments", href: "/segments", labelKey: "nav.segments", icon: Workflow },
      { page: "discounts", href: "/discounts", labelKey: "nav.discounts", icon: Tag },
    ],
  },
  {
    labelKey: "nav.sections.platform",
    items: [
      { page: "integrations", href: "/integrations", labelKey: "nav.integrations", icon: Plug },
      { page: "users", href: "/users", labelKey: "nav.users", icon: Users },
      { page: "settings", href: "/settings", labelKey: "nav.settings", icon: Settings },
      // add-on settings sit with the store settings, not with the daily work (issue #69)
      { page: "cod_settings", href: "/cod/settings", labelKey: "nav.cod_settings", icon: PhoneCall },
      { page: "whatsapp_settings", href: "/whatsapp/settings", labelKey: "nav.whatsapp_settings", icon: MessageCircle },
      { page: "audit", href: "/audit", labelKey: "nav.audit", icon: ScrollText },
      { page: "notifications", href: "/notifications", labelKey: "nav.notifications", icon: Bell },
      { page: "support", href: "/support", labelKey: "nav.support", icon: LifeBuoy },
    ],
  },
];

/** Link, label and icon of each bottom-bar destination (#49); which ones a user gets comes from resolveMobileNav. */
export const MOBILE_NAV_ITEMS: Record<MobileNavKey, { href: string; labelKey: string; icon: LucideIcon }> = {
  dashboard: { href: "", labelKey: "nav.dashboard", icon: Gauge },
  orders: { href: "/orders", labelKey: "nav.orders", icon: ShoppingBag },
  fulfilment: { href: "/fulfilment", labelKey: "nav.fulfilment", icon: PackageCheck },
  shipments: { href: "/shipments", labelKey: "nav.shipments", icon: Truck },
  returns: { href: "/returns", labelKey: "nav.returns", icon: RotateCcw },
  tasks: { href: "/tasks", labelKey: "nav.tasks", icon: ListChecks },
  cod_queue: { href: "/cod", labelKey: "nav.cod_queue", icon: PhoneCall },
  products: { href: "/products", labelKey: "nav.products", icon: Package },
  inventory: { href: "/inventory", labelKey: "nav.inventory", icon: Boxes },
  stock_takes: { href: "/inventory/stock-takes", labelKey: "mobile.nav.stock_takes", icon: ClipboardCheck },
  purchasing: { href: "/purchasing", labelKey: "nav.purchasing", icon: ClipboardList },
  campaigns: { href: "/campaigns", labelKey: "nav.campaigns", icon: Megaphone },
  analytics: { href: "/analytics", labelKey: "nav.analytics", icon: BarChart3 },
  customers: { href: "/customers", labelKey: "nav.customers", icon: Contact },
  notifications: { href: "/notifications", labelKey: "nav.notifications", icon: Bell },
  approvals: { href: "/approvals", labelKey: "mobile.nav.approvals", icon: Inbox },
  assistant: { href: "/assistant", labelKey: "nav.assistant", icon: Sparkles },
};
