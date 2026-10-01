import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & { id: string; isSuperAdmin: boolean; locale: string | null; sessionVersion: number };
  }
  interface User {
    isSuperAdmin?: boolean;
    locale?: string | null;
    sessionVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    isSuperAdmin?: boolean;
    locale?: string | null;
    /** users.session_version when the token was issued or last refreshed with a server proof. */
    sv?: number;
  }
}
