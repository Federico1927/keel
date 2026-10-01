"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { BrowserFrame } from "@/components/browser-frame";
import type { LandingLocale } from "@/config/site";
import { cx } from "@/lib/cx";

export interface ModuleSlide {
  key: string;
  shot: string;
  title: string;
  body: string;
  alt: string;
}

const AUTOPLAY_MS = 6000;

/**
 * Horizontal carousel of module screenshots: native scroll-snap (swipe on touch, trackpad, arrows),
 * a tab strip with the module names, prev/next buttons and gentle auto-advance that stops on the
 * first manual interaction, pauses on hover/focus and respects `prefers-reduced-motion`.
 */
export function ModulesCarousel({
  locale,
  slides,
}: {
  locale: LandingLocale;
  slides: ModuleSlide[];
}) {
  const t = useTranslations("modules");
  const trackRef = useRef<HTMLUListElement>(null);
  const [index, setIndex] = useState(0);
  const [autoplay, setAutoplay] = useState(true);
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const total = slides.length;

  const scrollTo = useCallback((i: number, behavior: ScrollBehavior = "smooth") => {
    const track = trackRef.current;
    const target = track?.children[i] as HTMLElement | undefined;
    if (!track || !target) return;
    track.scrollTo({ left: target.offsetLeft - track.offsetLeft, behavior });
  }, []);

  /** Manual navigation: move and stop the auto-advance for good. */
  const go = useCallback(
    (i: number) => {
      setAutoplay(false);
      scrollTo(((i % total) + total) % total);
    },
    [scrollTo, total],
  );

  // Active slide follows the scroll position (swipe, trackpad, keyboard scrolling).
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const children = Array.from(track.children) as HTMLElement[];
        const left = track.scrollLeft + track.offsetLeft;
        let best = 0;
        let bestDist = Number.POSITIVE_INFINITY;
        children.forEach((c, i) => {
          const d = Math.abs(c.offsetLeft - left);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        });
        setIndex(best);
      });
    };
    track.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      track.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Auto-advance only while visible, not hovered/focused and not disabled by the user or the OS.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting)),
      { threshold: 0.4 },
    );
    observer.observe(track);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!autoplay || paused || !inView) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => scrollTo((index + 1) % total), AUTOPLAY_MS);
    return () => window.clearInterval(id);
  }, [autoplay, paused, inView, index, total, scrollTo]);

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={t("carousel_label")}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label={t("carousel_label")}
        >
          {slides.map((s, i) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-controls={`module-slide-${s.key}`}
              onClick={() => go(i)}
              className={cx(
                "whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors",
                i === index
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {s.title}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm tabular text-muted-foreground" aria-live="polite">
            {t("slide", { n: index + 1, total })}
          </span>
          <IconButton
            label={autoplay ? t("pause") : t("play")}
            pressed={!autoplay}
            onClick={() => setAutoplay((v) => !v)}
          >
            {autoplay ? <Pause className="size-4" /> : <Play className="size-4" />}
          </IconButton>
          <IconButton label={t("prev")} onClick={() => go(index - 1)}>
            <ChevronLeft className="size-5" />
          </IconButton>
          <IconButton label={t("next")} onClick={() => go(index + 1)}>
            <ChevronRight className="size-5" />
          </IconButton>
        </div>
      </div>

      <ul
        ref={trackRef}
        className="mt-6 flex snap-x snap-mandatory gap-6 overflow-x-auto scroll-smooth pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-live={autoplay ? "off" : "polite"}
      >
        {slides.map((s, i) => (
          <li
            key={s.key}
            id={`module-slide-${s.key}`}
            role="group"
            aria-roledescription="slide"
            aria-label={t("slide", { n: i + 1, total })}
            className="w-full shrink-0 snap-start md:w-[88%] lg:w-[80%]"
          >
            <article className="grid h-full gap-6 rounded-2xl border border-border bg-card p-5 sm:p-6 lg:grid-cols-[3fr_2fr] lg:items-center">
              <BrowserFrame
                locale={locale}
                name={s.shot}
                role="card"
                alt={s.alt}
                priority={i === 0}
                sizes="(min-width: 1100px) 600px, (min-width: 768px) 80vw, 100vw"
              />
              <div>
                <h3 className="text-2xl sm:text-3xl">{s.title}</h3>
                <p className="mt-3 leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
            </article>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex justify-center gap-1.5" aria-hidden="true">
        {slides.map((s, i) => (
          <button
            key={s.key}
            type="button"
            tabIndex={-1}
            onClick={() => go(i)}
            className={cx(
              "h-1.5 rounded-full transition-all",
              i === index ? "w-6 bg-foreground" : "w-1.5 bg-border hover:bg-muted-foreground",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function IconButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-muted"
    >
      {children}
    </button>
  );
}
