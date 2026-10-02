import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  matcher: ["/((?!api/auth|api/mcp|api/oauth|\\.well-known|_next/static|_next/image|favicon.ico|screenshots|.*\\.(?:png|svg|jpg|ico|css|js)).*)"],
};
