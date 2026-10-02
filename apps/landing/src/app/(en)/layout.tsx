import type { Metadata, Viewport } from "next";
import { LandingLayout } from "@/landing/layout";
import { landingMetadata, landingViewport } from "@/landing/metadata";

export const metadata: Metadata = landingMetadata("en");
export const viewport: Viewport = landingViewport;

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LandingLayout locale="en">{children}</LandingLayout>;
}
