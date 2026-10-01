"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-renders the server page every few seconds while something is still running (background exports). */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
