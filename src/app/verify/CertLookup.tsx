'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  Camera,
  CameraOff,
  Upload,
  Loader2,
  X,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { extractCertNo } from '@/lib/constants';
import styles from './verify.module.css';

/**
 * Certificate lookup: type a number, or scan a QR code with a decoder that
 * actually decodes.
 *
 * What was here before did none of that. Its "Upload QR Image" tab ran a regular
 * expression over the *file name* and, when that found nothing — which is almost
 * always — verified the hardcoded string `CERT-2026-A7X9K2`. Its "Live Camera
 * Scanner" opened a real camera stream, drew an animated targeting reticle over
 * it, and never looked at a single frame; next to it sat two buttons shipped to
 * the public that verified two hardcoded certificate numbers on click. A citizen
 * could point that scanner at a blank wall and be told a certificate was valid.
 *
 * The replacement uses the browser's own `BarcodeDetector`, which is a real QR
 * decoder and needs no third-party library. It is not available everywhere —
 * Chromium-based browsers have it, Firefox and Safari do not — so support is
 * feature-detected, and where it is missing this component says so and points at
 * the phone's own camera app, which decodes the code natively and opens the result
 * page directly. An honest "your browser cannot do this, here is what can" beats a
 * scanner that appears to work.
 */

/* ------------------------------------------------------------------ *
 * BarcodeDetector — not yet in TypeScript's DOM library
 * ------------------------------------------------------------------ */

interface DetectedBarcode {
  rawValue: string;
  format: string;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

function getBarcodeDetector(): BarcodeDetectorConstructor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

/** First decodable VTULA certificate number among the codes in one frame. */
function firstCertNo(codes: DetectedBarcode[]): string | null {
  for (const code of codes) {
    const certNo = extractCertNo(code.rawValue);
    if (certNo) return certNo;
  }
  return null;
}

/** Milliseconds between decode attempts. Fast enough to feel instant, slow
 *  enough not to pin the CPU of a low-end phone. */
const FRAME_INTERVAL_MS = 220;

export default function CertLookup() {
  const router = useRouter();

  const [input, setInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [canScan, setCanScan] = useState<'unknown' | 'yes' | 'no'>('unknown');

  const videoRef = useRef<HTMLVideoElement>(null);

  /*
   * Support is asked of the API rather than inferred from the user agent, and it
   * asks for the format specifically: a browser can expose `BarcodeDetector`
   * while its platform has no QR decoder behind it.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const Detector = getBarcodeDetector();
      const formats = await (Detector
        ? Detector.getSupportedFormats().catch(() => [] as string[])
        : Promise.resolve<string[]>([]));
      if (cancelled) return;
      setCanScan(formats.includes('qr_code') ? 'yes' : 'no');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Both entry points converge on the one canonical result URL. */
  const goToResult = useCallback(
    (certNo: string, manual: boolean) => {
      router.push(`/verify/${encodeURIComponent(certNo)}${manual ? '?src=manual' : ''}`);
    },
    [router]
  );

  /* --- Camera scanning -------------------------------------------------- */
  /*
   * The camera's whole lifecycle lives in this effect so that stopping the scan,
   * navigating away, or unmounting all release the track. The previous version
   * stopped the stream only when its modal's close button was clicked, so a
   * successful "scan" left the camera running.
   */
  useEffect(() => {
    if (!scanning) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;

    (async () => {
      const Detector = getBarcodeDetector();
      if (!Detector) return;

      let detector: BarcodeDetectorLike;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        detector = new Detector({ formats: ['qr_code'] });
      } catch (err) {
        if (cancelled) return;
        const denied = err instanceof DOMException && err.name === 'NotAllowedError';
        setScanError(
          denied
            ? 'Camera permission was refused, so the code cannot be scanned here. Type the number printed under the QR code instead.'
            : 'No camera could be opened on this device. Type the number printed under the QR code instead.'
        );
        setScanning(false);
        return;
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);

      const tick = async () => {
        if (cancelled) return;
        try {
          const certNo = firstCertNo(await detector.detect(video));
          if (certNo) {
            if (cancelled) return;
            setScanning(false);
            goToResult(certNo, false);
            return;
          }
        } catch {
          // A frame with nothing decodable in it is the normal case, not an error.
        }
        if (!cancelled) timer = window.setTimeout(tick, FRAME_INTERVAL_MS);
      };

      void tick();
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [scanning, goToResult]);

  /* --- Decoding an uploaded photograph of a QR code --------------------- */
  const decodeImage = useCallback(
    async (file: File) => {
      const Detector = getBarcodeDetector();
      if (!Detector) return;

      setDecoding(true);
      setScanError(null);

      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(file);
        const certNo = firstCertNo(await new Detector({ formats: ['qr_code'] }).detect(bitmap));
        if (certNo) {
          goToResult(certNo, false);
          return;
        }
        setScanError(
          'No QR code could be read in that image. Try a closer, sharper photograph of just the code — or type the number printed beneath it.'
        );
      } catch {
        setScanError('That file could not be read as an image.');
      } finally {
        bitmap?.close();
        setDecoding(false);
      }
    },
    [goToResult]
  );

  /* --- Manual entry ----------------------------------------------------- */
  function submit(e: FormEvent) {
    e.preventDefault();
    const raw = input.trim();
    if (!raw) return;
    /*
     * Parsed with the same helper the server uses, so a pasted link and a typed
     * number resolve identically. Anything unparseable is still passed through:
     * `publicVerify` echoes back exactly what was searched for, which is how
     * someone spots that they read a 0 as an O.
     */
    goToResult(extractCertNo(raw) ?? raw, true);
  }

  return (
    <div className={styles.lookup}>
      <form onSubmit={submit} className={styles.searchForm}>
        <div className={styles.searchInput}>
          <Search size={20} />
          <input
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="Certificate number, e.g. VT-CERT-2026-000123"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Certificate number"
            required
          />
          {input && (
            <button
              type="button"
              className={styles.clearBtn}
              onClick={() => setInput('')}
              aria-label="Clear"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <button type="submit" className="clay-btn clay-btn-primary clay-btn-lg">
          <Search size={18} />
          Check
        </button>
      </form>

      {/* Only offered when there is a decoder behind it. */}
      {canScan === 'yes' && (
        <div className={styles.scanPanel}>
          {scanning ? (
            <>
              <div className={styles.cameraBox}>
                <video ref={videoRef} playsInline muted className={styles.videoPreview} />
                <div className={styles.scannerOverlay}>
                  <div className={styles.scannerTarget} />
                </div>
              </div>
              <p className={styles.scanHint}>
                Hold the QR code inside the frame. The result opens as soon as it is read — there is
                nothing to press.
              </p>
              <button
                type="button"
                className="clay-btn clay-btn-sm clay-btn-ghost"
                onClick={() => setScanning(false)}
              >
                <CameraOff size={15} />
                Stop the camera
              </button>
            </>
          ) : (
            <div className={styles.scanActions}>
              <button
                type="button"
                className="clay-btn clay-btn-secondary"
                onClick={() => {
                  setScanError(null);
                  setScanning(true);
                }}
              >
                <Camera size={17} />
                Scan with this device
              </button>

              <label className={styles.uploadBtn}>
                {decoding ? <Loader2 size={17} className={styles.spin} /> : <Upload size={17} />}
                {decoding ? 'Reading…' : 'Read a photo of the code'}
                <input
                  type="file"
                  accept="image/*"
                  disabled={decoding}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Reset so choosing the same file twice fires again.
                    e.target.value = '';
                    if (file) void decodeImage(file);
                  }}
                />
              </label>
            </div>
          )}
        </div>
      )}

      {/*
        * No decoder in this browser. Rather than a scanner that cannot scan, the
        * genuinely faster route is named: the phone's own camera app reads the code
        * and opens this site at the result.
        */}
      {canScan === 'no' && (
        <p className={styles.scanUnsupported}>
          <Info size={15} />
          <span>
            This browser cannot decode QR codes. Point your phone&apos;s normal camera app at the
            code on the sticker — it will open the result directly. Or type the number above.
          </span>
        </p>
      )}

      {scanError && (
        <p className={styles.scanErrorBox}>
          <AlertTriangle size={15} />
          <span>{scanError}</span>
        </p>
      )}
    </div>
  );
}
