import { CaseQueue } from "../case-queue";

import { withIntl } from "@/i18n/intl-scope";
/** Delivery-exception work queue (issue #28). */
async function ExceptionsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  return <CaseQueue tenant={tenant} kind="exception" sp={await searchParams} />;
}

export default withIntl(ExceptionsPage, "app/t/[tenant]/fulfilment/exceptions/page.tsx");
