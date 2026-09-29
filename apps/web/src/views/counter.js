import { api } from '../api.js';
import { $, esc } from '../dom.js';
import { errorText, t } from '../i18n.js';
import { showMessage } from './common.js';
import { mountRedeem } from './redeem.js';
import { mountScan, scanBox } from './scan.js';

/** @typedef {import('../main.js').App} App */

export function counterPanel() {
  return `
    <section class="card-sw counter">
      <h2 class="card-title">${esc(t('counterTitle'))}</h2>
      <p class="text-muted small mb-3">${esc(t('counterSubtitle'))}</p>
      <div id="counter-scan">${scanBox()}</div>
      <div id="counter-result"></div>
    </section>`;
}

/**
 * Scan or type a code, look it up in the signed-in merchant, then redeem.
 * @param {App} _app
 */
export function mountCounter(_app) {
  const scan = $('#counter-scan');
  const result = $('#counter-result');
  const reset = () => {
    result.innerHTML = '';
    scan.hidden = false;
  };
  mountScan(scan, async (code) => {
    try {
      const { voucher } = await api('GET', `/api/v1/vouchers/${encodeURIComponent(code)}`);
      scan.hidden = true;
      mountRedeem(result, voucher, reset);
    } catch (error) {
      showMessage(errorText(error), 'error', 'scan-message');
    }
  });
}
