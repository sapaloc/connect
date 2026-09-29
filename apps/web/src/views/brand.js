import { brandColorFor, brandTextColor, parseBrandColor } from '#domain';
import { api } from '../api.js';
import { $, busy, esc } from '../dom.js';
import { errorText, t } from '../i18n.js';
import { prepareLogo } from '../image.js';
import { messageSlot, showMessage } from './common.js';
import { cardHead } from './voucher-card.js';

/** @typedef {import('../main.js').App} App */
/** @typedef {import('../voucher-ui.js').Brand} Brand */

const DEFAULT_COLOR = '#28332C';

/** Logo and colour shown to customers on the partner page, voucher cards and share images. */
export function brandPanel() {
  return `
    <section class="card-sw">
      <h2 class="card-title">${esc(t('brandPreview'))}</h2>
      <p class="small text-muted">${esc(t('brandPreviewHint'))}</p>
      <div class="vcard brand-preview" id="brand-preview"></div>
    </section>

    <section class="card-sw">
      <h2 class="card-title">${esc(t('brandLogo'))}</h2>
      <p class="small text-muted">${esc(t('brandLogoHint'))}</p>
      <input type="file" id="brand-file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" hidden />
      <div class="d-flex flex-wrap gap-2">
        <button type="button" class="btn btn-primary" id="brand-pick">${esc(t('brandPickLogo'))}</button>
        <button type="button" class="btn btn-outline-danger" id="brand-remove" hidden>${esc(t('brandRemoveLogo'))}</button>
      </div>
      ${messageSlot('brand-logo-message')}
    </section>

    <section class="card-sw">
      <h2 class="card-title">${esc(t('brandColor'))}</h2>
      <p class="small text-muted">${esc(t('brandColorHint'))}</p>
      <form id="brand-color-form" novalidate>
        <div class="d-flex gap-2 align-items-center">
          <input type="color" id="brand-color-picker" class="form-control form-control-color" value="${DEFAULT_COLOR}" aria-label="${esc(t('brandColor'))}" />
          <input id="brand-color" name="brandColor" class="form-control font-monospace text-uppercase" maxlength="7" placeholder="${DEFAULT_COLOR}" autocomplete="off" />
        </div>
        <div class="d-flex flex-wrap gap-2 mt-3">
          <button type="submit" class="btn btn-primary">${esc(t('saveBtn'))}</button>
          <button type="button" class="btn btn-outline-secondary" id="brand-color-reset">${esc(t('brandUseDefault'))}</button>
        </div>
        ${messageSlot('brand-color-message')}
      </form>
    </section>`;
}

/** @param {App} app */
export async function mountBrand(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  const merchantName = profile.activeRole?.tenantName ?? 'MyConnect';
  /** @type {Brand | null} */
  let saved = null;
  const picker = /** @type {HTMLInputElement} */ ($('#brand-color-picker'));
  const hex = /** @type {HTMLInputElement} */ ($('#brand-color'));
  const file = /** @type {HTMLInputElement} */ ($('#brand-file'));

  /** Preview with the typed colour, even before it is saved. */
  const preview = () => {
    const typed = parseBrandColor(hex.value);
    const color = typed ?? saved?.color ?? null;
    const brand = { logoUrl: saved?.logoUrl ?? null, color, textColor: color ? brandTextColor(color) : null };
    $('#brand-preview').innerHTML = `
      ${cardHead({ eyebrow: t('voucherTitle'), merchantName, brand })}
      <div class="vcard-body"><p class="vcard-discount mb-0">${esc(t('percentOff', { value: '10' }))}</p></div>`;
    if (!hex.value.trim()) return showMessage('', 'info', 'brand-color-message');
    const check = brandColorFor(hex.value);
    if ('error' in check) showMessage(t(`err_${check.error}`), 'error', 'brand-color-message');
    else showMessage('', 'info', 'brand-color-message');
  };

  const apply = (/** @type {Brand | null} */ brand) => {
    saved = brand;
    hex.value = brand?.color ?? '';
    picker.value = brand?.color ?? DEFAULT_COLOR;
    $('#brand-remove').hidden = !brand?.logoUrl;
    preview();
  };

  try {
    apply((await api('GET', '/api/v1/merchant/settings')).brand);
  } catch (error) {
    showMessage(errorText(error), 'error', 'brand-logo-message');
  }

  picker.addEventListener('input', () => {
    hex.value = picker.value.toUpperCase();
    preview();
  });
  hex.addEventListener('input', () => {
    const color = parseBrandColor(hex.value);
    if (color) picker.value = color;
    preview();
  });

  $('#brand-pick').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    const button = /** @type {HTMLButtonElement} */ ($('#brand-pick'));
    button.disabled = true;
    showMessage(t('brandUploading'), 'info', 'brand-logo-message');
    try {
      const { brand } = await api('POST', '/api/v1/merchant/logo', await prepareLogo(picked));
      apply(brand);
      showMessage(t('brandLogoSaved'), 'success', 'brand-logo-message');
    } catch (error) {
      showMessage(errorText(error), 'error', 'brand-logo-message');
    } finally {
      button.disabled = false;
    }
  });

  $('#brand-remove').addEventListener('click', async () => {
    if (!confirm(t('brandRemoveConfirm'))) return;
    try {
      apply((await api('POST', '/api/v1/merchant/logo/remove', {})).brand);
      showMessage(t('brandLogoRemoved'), 'success', 'brand-logo-message');
    } catch (error) {
      showMessage(errorText(error), 'error', 'brand-logo-message');
    }
  });

  const form = /** @type {HTMLFormElement} */ ($('#brand-color-form'));
  const saveColor = (/** @type {string | null} */ value) =>
    busy(form, async () => {
      try {
        apply((await api('POST', '/api/v1/merchant/brand', { brandColor: value })).brand);
        showMessage(t('brandColorSaved'), 'success', 'brand-color-message');
      } catch (error) {
        showMessage(errorText(error), 'error', 'brand-color-message');
      }
    });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveColor(hex.value.trim() || null);
  });
  $('#brand-color-reset').addEventListener('click', () => saveColor(null));
}
