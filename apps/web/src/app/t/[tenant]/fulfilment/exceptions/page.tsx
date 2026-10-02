import { CaseQueue } from "../case-queue";

/** Delivery-exception work queue (issue #28). */
export default async function ExceptionsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  return <CaseQueue tenant={tenant} kind="exception" sp={await searchParams} />;
}
