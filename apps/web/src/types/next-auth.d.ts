import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & { id: string; isSuperAdmin: boolean; locale: string | null };
  }
  interface User {
    isSuperAdmin?: boolean;
    locale?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    isSuperAdmin?: boolean;
    locale?: string | null;
  }
}
