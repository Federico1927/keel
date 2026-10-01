import { PLATFORM_CURRENCY } from "@keel/config";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDateTime, formatMoney, formatNumber } from "@keel/core";
import { tenantsOverview } from "@keel/services";
import {
  Badge,
  Button,
  Card,
  CardContent,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { OpenAsSupportButton } from "./[id]/controls";

export default async function AdminTenantsPage() {
  const { db } = await requireSuperAdmin();
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const tenants = await tenantsOverview(db);
  return (
    <>
      <PageHeader
        eyebrow={t("console")}
        title={t("tenants.title")}
        description={t("tenants.description")}
        actions={
          <Button asChild>
            <Link href="/admin/tenants/new">{t("tenants.new")}</Link>
          </Button>
        }
      />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("tenants.columns.tenant")}</TableHead>
                <TableHead>{t("tenants.columns.plan")}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("tenants.columns.addons")}
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t("tenants.columns.integrations")}
                </TableHead>
                <TableHead className="text-right">{t("tenants.columns.orders30")}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("tenants.columns.last_login")}
                </TableHead>
                <TableHead>{t("tenants.columns.payment")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map((x) => (
                <TableRow key={x.id} data-testid="tenant-row">
                  <TableCell>
                    <Link href={`/admin/tenants/${x.id}`} className="font-medium hover:underline">
                      {x.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {x.slug} · {x.country} · {x.currency}{" "}
                      <Badge
                        variant={
                          x.status === "active"
                            ? "success"
                            : x.status === "suspended"
                              ? "destructive"
                              : "warning"
                        }
                        className="ml-1"
                      >
                        {t(`tenants.status.${x.status}`)}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>{t(`plans.${x.planKey}`)}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {x.addons.length
                      ? x.addons.map((a) => (
                          <Badge key={a} variant="outline" className="mr-1 font-mono text-[10px]">
                            {a}
                          </Badge>
                        ))
                      : "—"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <span className="flex gap-1">
                      {x.integrations.map((i) => (
                        <span
                          key={i.provider}
                          title={`${i.provider}: ${i.status}`}
                          className={`h-2.5 w-2.5 rounded-full ${i.status === "connected" ? "bg-green-500" : i.status === "error" ? "bg-red-500" : "bg-muted-foreground/30"}`}
                        />
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {formatNumber(x.ordersLast30, locale)}
                  </TableCell>
                  <TableCell className="hidden text-xs md:table-cell">
                    {x.lastLoginAt ? formatDateTime(x.lastLoginAt, locale, "UTC") : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        x.payment === "ok"
                          ? "success"
                          : x.payment === "past_due"
                            ? "warning"
                            : x.payment === "suspended"
                              ? "destructive"
                              : "muted"
                      }
                    >
                      {t(`payment.${x.payment}`)}
                    </Badge>
                    {x.openMinor > 0 && (
                      <div className="text-xs text-muted-foreground tabular">
                        {formatMoney(x.openMinor, PLATFORM_CURRENCY, locale)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <OpenAsSupportButton tenantId={x.id} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
