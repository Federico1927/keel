import type { PageKey } from "@keel/config";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bell,
  LifeBuoy,
  ListChecks,
  Boxes,
  CalendarRange,
  ClipboardList,
  Contact,
  Gauge,
  Megaphone,
  Package,
  PhoneCall,
  Plug,
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
      { page: "shipments", href: "/shipments", labelKey: "nav.shipments", icon: Truck },
      { page: "returns", href: "/returns", labelKey: "nav.returns", icon: RotateCcw },
      { page: "tasks", href: "/tasks", labelKey: "nav.tasks", icon: ListChecks },
      { page: "cod_queue", href: "/cod", labelKey: "nav.cod_queue", icon: PhoneCall },
      { page: "cod_settings", href: "/cod/settings", labelKey: "nav.cod_settings", icon: PhoneCall },
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
      { page: "audit", href: "/audit", labelKey: "nav.audit", icon: ScrollText },
      { page: "notifications", href: "/notifications", labelKey: "nav.notifications", icon: Bell },
      { page: "support", href: "/support", labelKey: "nav.support", icon: LifeBuoy },
    ],
  },
];
