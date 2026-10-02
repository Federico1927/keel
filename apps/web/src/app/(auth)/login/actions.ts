"use server";
import { AuthError } from "next-auth";
import { z } from "zod";
import { adminDb, eq, schema } from "@keel/db";
import { safeNextPath } from "@keel/core";
import { signIn } from "@/auth";

export type LoginState = { error?: "invalid_credentials" | "invalid_input" | "unknown"; sent?: boolean } | null;

const passwordSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const emailSchema = z.object({ email: z.string().email() });

export async function signInWithPassword(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = passwordSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "invalid_input" };
  try {
    await signIn("credentials", { ...parsed.data, redirectTo: safeNextPath(formData.get("next")) });
    return null;
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: err.type === "CredentialsSignin" ? "invalid_credentials" : "unknown" };
    }
    throw err; // NEXT_REDIRECT
  }
}

/**
 * Email link: the same answer whether or not the address has an account (no enumeration). A link is
 * sent only to an existing account; unknown addresses never get one, so no account is created by it.
 */
export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = emailSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { error: "invalid_input" };
  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await adminDb().select({ id: schema.users.id, disabledAt: schema.users.disabledAt }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!user || user.disabledAt) return { sent: true };
  try {
    await signIn("email", { email, redirect: false, redirectTo: safeNextPath(formData.get("next")) });
    return { sent: true };
  } catch (err) {
    if (err instanceof AuthError) return { error: "unknown" };
    throw err;
  }
}
