"use client";
import * as React from "react";
import { ScanLine } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

/** Window event that stands in for the camera (e2e tests, hardware integrations): `new CustomEvent(SCAN_EVENT, { detail: "SKU-1" })`. */
export const SCAN_EVENT = "app:scan";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "itf", "codabar", "qr_code", "data_matrix"];

type Detect = (video: HTMLVideoElement) => Promise<string | null>;

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/** Native `BarcodeDetector` when the browser has one, otherwise ZXing (loaded only then) on canvas frames. */
async function makeDetector(): Promise<Detect> {
  const Native = (globalThis as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): BarcodeDetectorLike; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
  if (Native) {
    const supported = (await Native.getSupportedFormats?.()) ?? FORMATS;
    const detector = new Native({ formats: FORMATS.filter((f) => supported.includes(f)) });
    return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
  }
  const zx = await import("@zxing/library");
  const reader = new zx.MultiFormatReader();
  const hints = new Map<unknown, unknown>([[zx.DecodeHintType.TRY_HARDER, true]]);
  reader.setHints(hints as Map<never, never>);
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    if (!g || !video.videoWidth) return null;
    // a centred band is enough for 1D codes and keeps the work per frame small
    const w = Math.min(video.videoWidth, 960);
    const h = Math.round((video.videoHeight / video.videoWidth) * w);
    canvas.width = w;
    canvas.height = h;
    g.drawImage(video, 0, 0, w, h);
    const { data } = g.getImageData(0, 0, w, h);
    const lum = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) lum[j] = (data[i]! * 299 + data[i + 1]! * 587 + data[i + 2]! * 114) / 1000;
    try {
      return reader.decodeWithState(new zx.BinaryBitmap(new zx.HybridBinarizer(new zx.RGBLuminanceSource(lum, w, h)))).getText();
    } catch {
      return null;
    }
  };
}

export interface ScanLabels {
  /** Button text and accessible name ("Scan"). */
  open: string;
  title: string;
  hint: string;
  /** No camera, permission refused or insecure page: type the code instead. */
  unavailable: string;
  close: string;
  /** Continuous mode: after each code ("Scanned {code}"); `{code}` is replaced. */
  scanned?: string;
}

/**
 * Camera barcode / QR scanner (#49). Opens a full-screen sheet with the rear camera and calls
 * `onScan` with each code read. `continuous` keeps it open (stock-takes) and ignores the same code
 * for a moment; otherwise it closes on the first code. Typing the code in the page's own field is
 * always possible: the scanner only fills it faster.
 */
export function ScanButton({ onScan, labels, continuous = false, className, iconOnly = false, size = "default" }: { onScan: (code: string) => void; labels: ScanLabels; continuous?: boolean; className?: string; iconOnly?: boolean; size?: "sm" | "default" }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" variant="outline" size={iconOnly ? "icon" : size} className={cn("shrink-0", className)} onClick={() => setOpen(true)} aria-label={labels.open} data-testid="scan-camera">
        <ScanLine /> {!iconOnly && <span>{labels.open}</span>}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent mobile="fullscreen" className="content-start gap-3 sm:max-w-md" closeLabel={labels.close}>
          {open && <ScannerView labels={labels} continuous={continuous} onScan={onScan} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScannerView({ labels, continuous, onScan, onDone }: { labels: ScanLabels; continuous: boolean; onScan: (code: string) => void; onDone: () => void }) {
  const video = React.useRef<HTMLVideoElement>(null);
  const [error, setError] = React.useState(false);
  const [last, setLast] = React.useState<string | null>(null);
  const recent = React.useRef<{ code: string; at: number } | null>(null);
  const handler = React.useRef(onScan);
  handler.current = onScan;

  const accept = React.useCallback((raw: string) => {
    const code = raw.trim();
    if (!code) return;
    const now = Date.now();
    if (recent.current && recent.current.code === code && now - recent.current.at < 1500) return;
    recent.current = { code, at: now };
    navigator.vibrate?.(40);
    handler.current(code);
    setLast(code);
    if (!continuous) onDone();
  }, [continuous, onDone]);

  React.useEffect(() => {
    const onEvent = (e: Event) => accept(String((e as CustomEvent).detail ?? ""));
    window.addEventListener(SCAN_EVENT, onEvent);
    return () => window.removeEventListener(SCAN_EVENT, onEvent);
  }, [accept]);

  React.useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const detect = await makeDetector();
        const tick = async () => {
          if (stopped || !video.current) return;
          const code = await detect(video.current).catch(() => null);
          if (code) accept(code);
          timer = setTimeout(tick, 250);
        };
        void tick();
      } catch {
        if (!stopped) setError(true);
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [accept]);

  return (
    <>
      <DialogTitle>{labels.title}</DialogTitle>
      <DialogDescription>{error ? labels.unavailable : labels.hint}</DialogDescription>
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-black sm:aspect-video" data-testid="scanner-view" data-state={error ? "unavailable" : "live"}>
        <video ref={video} className="h-full w-full object-cover" playsInline muted />
        <div aria-hidden className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-destructive/80 shadow-[0_0_8px_var(--danger)]" />
      </div>
      {last && labels.scanned && <p className="text-sm font-medium text-success" role="status" data-testid="scanner-last">{labels.scanned.replace("{code}", last)}</p>}
      <Button type="button" variant="outline" className="w-full" onClick={onDone}>{labels.close}</Button>
    </>
  );
}
