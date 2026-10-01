"use server";
import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/auth";

export type LoginState = { error?: "invalid_credentials" | "invalid_input" | "unknown"; sent?: boolean } | null;

const passwordSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const emailSchema = z.object({ email: z.string().email() });

export async function signInWithPassword(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = passwordSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "invalid_input" };
  try {
    await signIn("credentials", { ...parsed.data, redirectTo: "/" });
    return null;
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: err.type === "CredentialsSignin" ? "invalid_credentials" : "unknown" };
    }
    throw err; // NEXT_REDIRECT
  }
}

export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = emailSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { error: "invalid_input" };
  try {
    await signIn("email", { email: parsed.data.email, redirect: false });
    return { sent: true };
  } catch (err) {
    if (err instanceof AuthError) return { error: "unknown" };
    throw err;
  }
}
