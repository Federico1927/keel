import { CaseQueue } from "../case-queue";

import { withIntl } from "@/i18n/intl-scope";
/** Return-to-sender review (issue #28). */
async function ReturnedPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  return <CaseQueue tenant={tenant} kind="return_to_sender" sp={await searchParams} />;
}

export default withIntl(ReturnedPage, "app/t/[tenant]/fulfilment/returned/page.tsx");
