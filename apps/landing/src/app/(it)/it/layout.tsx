import type { Metadata } from "next";
import { LandingLayout } from "@/landing/layout";
import { landingMetadata } from "@/landing/metadata";

export const metadata: Metadata = landingMetadata("it");

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LandingLayout locale="it">{children}</LandingLayout>;
}
