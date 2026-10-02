import { CaseQueue } from "../case-queue";

/** Return-to-sender review (issue #28). */
export default async function ReturnedPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  return <CaseQueue tenant={tenant} kind="return_to_sender" sp={await searchParams} />;
}
