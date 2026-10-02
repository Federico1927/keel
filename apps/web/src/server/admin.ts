import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { adminDb, type Database } from "@hullwise/db";
import { getCurrentUser, type CurrentUser } from "./session";

export interface AdminContext {
  user: CurrentUser;
  db: Database;
}

/** Super-admin guard: unknown users go to login, tenant users get a 404 (the console is not advertised). */
export const requireSuperAdmin = cache(async (): Promise<AdminContext> => {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.isSuperAdmin) notFound();
  return { user, db: adminDb() };
});
