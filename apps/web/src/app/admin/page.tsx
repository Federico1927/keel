import { redirect } from "next/navigation";
import { requireUser } from "@/server/session";

export default async function AdminHome() {
  const user = await requireUser();
  if (!user.isSuperAdmin) redirect("/");
  return (
    <main className="p-8">
      <h1 className="text-2xl">Super-admin</h1>
    </main>
  );
}
