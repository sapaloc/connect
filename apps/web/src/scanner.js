/** @type {(() => void) | null} */
let active = null;

/** Stops the camera of the scanner currently open, if any (called on every route change). */
export function stopScanner() {
  active?.();
  active = null;
}

/**
 * Opens the back camera in `video` and calls `onText` with each QR payload read.
 * Uses the native BarcodeDetector when the browser has it (Chrome Android), jsQR otherwise (Safari iOS).
 * Rejects when the camera is unavailable or permission is denied.
 * @param {HTMLVideoElement} video
 * @param {(text: string) => void} onText
 */
export async function startScanner(video, onText) {
  stopScanner();
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  let stopped = false;
  active = () => {
    stopped = true;
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();

  /** @type {(source: HTMLVideoElement) => Promise<string | null>} */
  let detect;
  const Detector = /** @type {any} */ (window).BarcodeDetector;
  if (Detector && (await Detector.getSupportedFormats?.())?.includes('qr_code')) {
    const detector = new Detector({ formats: ['qr_code'] });
    detect = async (source) => (await detector.detect(source))[0]?.rawValue ?? null;
  } else {
    const { default: jsQR } = await import('jsqr');
    const canvas = document.createElement('canvas');
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
    detect = async (source) => {
      const scale = Math.min(1, 640 / Math.max(source.videoWidth, 1));
      canvas.width = Math.round(source.videoWidth * scale);
      canvas.height = Math.round(source.videoHeight * scale);
      if (!canvas.width || !canvas.height) return null;
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
    };
  }

  const tick = async () => {
    if (stopped) return;
    try {
      const text = video.readyState >= 2 ? await detect(video) : null;
      if (text && !stopped) onText(text);
    } catch {
      // A frame that cannot be decoded is normal; keep scanning.
    }
    if (!stopped) setTimeout(tick, 200);
  };
  tick();
}
