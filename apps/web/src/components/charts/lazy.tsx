"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

/**
 * Dashboard charts load their chart library on demand (#49 performance): the page renders and
 * hydrates without it, a box of the chart's height holds the place (no layout shift), and on a phone
 * the chart loads only when it comes near the screen. Wider screens load it right after hydration.
 */
const RevenueChart = dynamic(() => import("./revenue-chart").then((m) => m.RevenueChart), { ssr: false, loading: () => null });
const MetricChart = dynamic(() => import("./metric-chart").then((m) => m.MetricChart), { ssr: false, loading: () => null });

const PHONE = "(max-width: 767px)";

function Deferred({ height, children }: { height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia(PHONE).matches || typeof IntersectionObserver === "undefined") return setShow(true);
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setShow(true); io.disconnect(); } }, { rootMargin: "200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="w-full" style={{ minHeight: height }} data-chart-pending={show ? undefined : ""}>
      {show ? children : null}
    </div>
  );
}

export function LazyRevenueChart(props: ComponentProps<typeof RevenueChart>) {
  return <Deferred height={256}><RevenueChart {...props} /></Deferred>;
}

export function LazyMetricChart(props: ComponentProps<typeof MetricChart>) {
  return <Deferred height={props.height ?? 240}><MetricChart {...props} /></Deferred>;
}
