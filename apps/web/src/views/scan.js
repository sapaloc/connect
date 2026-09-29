import { parseVoucherCode } from '#domain';
import { $, esc } from '../dom.js';
import { t } from '../i18n.js';
import { icon } from '../nav.js';
import { startScanner, stopScanner } from '../scanner.js';
import { messageSlot, showMessage } from './common.js';

/** Camera scanner with a typed-code fallback. */
export function scanBox() {
  return `
    <div class="scan">
      <div class="scan-view" id="scan-view" hidden>
        <video id="scan-video" aria-label="${esc(t('scanQr'))}"></video>
        <span class="scan-frame" aria-hidden="true"></span>
      </div>
      <p class="small text-muted text-center mb-0" id="scan-hint" hidden>${esc(t('scanHint'))}</p>
      <div class="d-grid gap-2">
        <button type="button" class="btn btn-primary btn-lg scan-btn" id="scan-start">${icon('scan')}<span>${esc(t('scanQr'))}</span></button>
        <button type="button" class="btn btn-outline-secondary" id="scan-stop" hidden>${esc(t('stopScan'))}</button>
      </div>
      <form id="scan-manual" class="scan-manual" novalidate>
        <label for="scan-code" class="form-label small">${esc(t('enterCode'))}</label>
        <div class="input-group input-group-lg">
          <input id="scan-code" class="form-control font-monospace text-uppercase" placeholder="${esc(t('codePlaceholder'))}"
            autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="80" />
          <button type="submit" class="btn btn-outline-secondary">${esc(t('check'))}</button>
        </div>
      </form>
      ${messageSlot('scan-message')}
    </div>`;
}

/**
 * @param {ParentNode} root
 * @param {(code: string) => void} onCode called with a canonical voucher code
 */
export function mountScan(root, onCode) {
  const view = $('#scan-view', root);
  const start = /** @type {HTMLButtonElement} */ ($('#scan-start', root));
  const stop = /** @type {HTMLButtonElement} */ ($('#scan-stop', root));
  const hint = $('#scan-hint', root);

  const setScanning = (/** @type {boolean} */ on) => {
    view.hidden = !on;
    hint.hidden = !on;
    stop.hidden = !on;
    start.hidden = on;
  };

  /** @param {string} text */
  const accept = (text) => {
    const code = parseVoucherCode(text);
    if (!code) {
      showMessage(t('unknownCode'), 'error', 'scan-message');
      return false;
    }
    stopScanner();
    setScanning(false);
    showMessage('', 'info', 'scan-message');
    onCode(code);
    return true;
  };

  start.addEventListener('click', async () => {
    showMessage('', 'info', 'scan-message');
    setScanning(true);
    try {
      await startScanner(/** @type {HTMLVideoElement} */ ($('#scan-video', root)), accept);
    } catch {
      setScanning(false);
      showMessage(t('cameraDenied'), 'error', 'scan-message');
      $('#scan-code', root).focus();
    }
  });

  stop.addEventListener('click', () => {
    stopScanner();
    setScanning(false);
  });

  const manual = /** @type {HTMLFormElement} */ ($('#scan-manual', root));
  manual.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = /** @type {HTMLInputElement} */ ($('#scan-code', root));
    if (accept(input.value)) input.value = '';
  });
}
