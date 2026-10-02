import { fixedRuleFromAmounts, formatVoucherCode, isFixedRule, PARTNER_TYPES, percentRuleFromPercents, PRICING_MODELS, ratePercent, toVnd } from '#domain';
import { api } from '../api.js';
import { $, busy, esc, formValues } from '../dom.js';
import { errorText, formatDateTime, formatVnd, getLang, groupDigits, t } from '../i18n.js';
import { downloadBlob, partnerQrImage, referralLink, referralQrDataUrl, ruleDiscount, ruleTerms, sharePartnerQr, shortLink } from '../voucher-ui.js';
import { icon } from '../nav.js';
import { messageSlot, showLink, showMessage } from './common.js';
import { historyBlock, mountHistory, openDialog, openPayout, payoutItem } from './history.js';
import { mountReport, reportCard } from './report.js';
import { billPhotoList } from './voucher-card.js';

/** @typedef {import('../main.js').App} App */
/**
 * @typedef {{
 *   id: string, merchantId: string, merchantName: string | null, name: string,
 *   relationshipKind: 'COMPANY' | 'INDEPENDENT_INDIVIDUAL', partnerType: string,
 *   status: 'ACTIVE' | 'PAUSED' | 'ENDED', contactName: string | null, contactPhone: string | null,
 *   contactEmail: string | null, note: string | null, createdAt: string, endReason: string | null,
 *   rule: null | { version: number, pricingModel: 'FIXED_AMOUNT' | 'PERCENT', customerDiscountAmount: string | null,
 *     commissionAmount: string | null, totalBudgetRate: string, customerDiscountRate: string,
 *     companyCommissionRate: string | null, individualCommissionRate: string | null },
 *   accounts: { id: string, email: string, displayName: string, status: string, role: string }[],
 *   qr: null | { token: string, createdAt: string },
 *   brand?: import('../voucher-ui.js').Brand | null,
 *   stats?: { opens: number, activations: number, redemptions: number, commissionOpen?: string, commissionPaid?: string,
 *     commissionPending?: string, pendingReviews?: number, lastPaidAt?: string | null },
 * }} Partner
 */

const KINDS = ['COMPANY', 'INDEPENDENT_INDIVIDUAL'];

/** @param {string} label */
const optionalLabel = (label) => `${esc(label)} <span class="text-muted">(${esc(t('optional'))})</span>`;

/** @param {string} id */
function languageSelect(id) {
  return `
    <select id="${id}" name="preferredLanguage" class="form-select">
      <option value="en"${getLang() === 'en' ? ' selected' : ''}>EN</option>
      <option value="vi"${getLang() === 'vi' ? ' selected' : ''}>VI</option>
    </select>`;
}

const AMOUNT_FIELDS = ['customerDiscountAmount', 'commissionAmount'];
const PERCENT_FIELDS = ['customerDiscountPercent', 'commissionPercent'];
const MODELS = [PRICING_MODELS.FIXED_AMOUNT, PRICING_MODELS.PERCENT];

/** @param {string} value typed amount, with or without thousands separators */
const digitsOf = (value) => value.replace(/\D/g, '');

/** @param {string} value typed percent; a comma works as the decimal point */
const percentOf = (value) => value.replace(',', '.').replace(/[^\d.]/g, '');

/**
 * The partner's terms: a switch between fixed VND amounts per bill and percents, then the two values.
 * @param {string} prefix
 * @param {Partner['rule']} [rule] stored rule, to edit
 */
function ruleFields(prefix, rule = null) {
  const model = rule && !isFixedRule(rule) ? PRICING_MODELS.PERCENT : PRICING_MODELS.FIXED_AMOUNT;
  const amount = (/** @type {string | null | undefined} */ value) => (value && model === PRICING_MODELS.FIXED_AMOUNT ? groupDigits(toVnd(value)) : '');
  const percent = (/** @type {string | null | undefined} */ rate) => (rate && model === PRICING_MODELS.PERCENT ? ratePercent(rate) : '');
  const commissionRate = rule?.companyCommissionRate ?? rule?.individualCommissionRate;
  /** @param {string} name @param {string} label @param {string} value @param {string} placeholder @param {string} mode */
  const input = (name, label, value, placeholder, mode) => `
      <div class="col-6">
        <label for="${prefix}-${name}" class="form-label small">${esc(label)}</label>
        <input id="${prefix}-${name}" name="${name}" class="form-control" inputmode="${mode}" maxlength="16" autocomplete="off"
          value="${esc(value)}" placeholder="${placeholder}" />
      </div>`;
  return `
    <div class="btn-group w-100 mb-3" role="group" aria-label="${esc(t('pricingModel'))}">
      ${MODELS.map(
        (value) => `
        <input type="radio" class="btn-check" name="pricingModel" id="${prefix}-model-${value}" value="${value}"${value === model ? ' checked' : ''} />
        <label class="btn btn-outline-secondary" for="${prefix}-model-${value}">${esc(t(`pricingModel_${value}`))}</label>`,
      ).join('')}
    </div>
    <div class="row g-3" data-model="${PRICING_MODELS.FIXED_AMOUNT}"${model === PRICING_MODELS.FIXED_AMOUNT ? '' : ' hidden'}>
      ${input('customerDiscountAmount', t('customerDiscountAmount'), amount(rule?.customerDiscountAmount), '100.000', 'numeric')}
      ${input('commissionAmount', t('commissionAmount'), amount(rule?.commissionAmount), '150.000', 'numeric')}
    </div>
    <div class="row g-3" data-model="${PRICING_MODELS.PERCENT}"${model === PRICING_MODELS.PERCENT ? '' : ' hidden'}>
      ${input('customerDiscountPercent', t('customerDiscountPercent'), percent(rule?.customerDiscountRate), '10', 'decimal')}
      ${input('commissionPercent', t('commissionPercent'), percent(commissionRate), '15', 'decimal')}
    </div>
    <p class="rule-preview small mt-2 mb-0" id="${prefix}-preview" aria-live="polite"></p>`;
}

/**
 * @param {HTMLFormElement} form
 * @param {string} prefix
 * @param {() => string} kindOf
 */
function bindRulePreview(form, prefix, kindOf) {
  const preview = $(`#${prefix}-preview`, form);
  const update = (/** @type {Event} [event] */ event) => {
    const input = /** @type {HTMLInputElement | undefined} */ (event?.target);
    if (input && AMOUNT_FIELDS.includes(input.name)) input.value = groupDigits(digitsOf(input.value));
    if (input && PERCENT_FIELDS.includes(input.name)) input.value = percentOf(input.value);
    const payload = rulePayload(form);
    const percent = payload.pricingModel === PRICING_MODELS.PERCENT;
    for (const group of form.querySelectorAll('[data-model]')) {
      /** @type {HTMLElement} */ (group).hidden = group.getAttribute('data-model') !== payload.pricingModel;
    }
    const [discount, commission] = percent
      ? [payload.customerDiscountPercent, payload.commissionPercent]
      : [payload.customerDiscountAmount, payload.commissionAmount];
    if (!discount || !commission) {
      preview.textContent = t(percent ? 'ruleHintPercent' : 'ruleHint');
      preview.dataset.tone = 'info';
      return;
    }
    const { rule, errors } = percent
      ? percentRuleFromPercents({ relationshipKind: kindOf(), customerDiscountPercent: discount, commissionPercent: commission })
      : fixedRuleFromAmounts({ relationshipKind: kindOf(), customerDiscountAmount: discount, commissionAmount: commission });
    if (rule) {
      preview.textContent = t(percent ? 'rulePreviewPercent' : 'rulePreview', ruleTerms(rule));
      preview.dataset.tone = 'success';
    } else {
      preview.textContent = t(`rule_${errors[0]}`);
      preview.dataset.tone = 'error';
    }
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
}

/** @param {HTMLFormElement} form */
function rulePayload(form) {
  const values = formValues(form);
  if (values.pricingModel === PRICING_MODELS.PERCENT) {
    return {
      pricingModel: PRICING_MODELS.PERCENT,
      customerDiscountPercent: percentOf(values.customerDiscountPercent),
      commissionPercent: percentOf(values.commissionPercent),
    };
  }
  return {
    pricingModel: PRICING_MODELS.FIXED_AMOUNT,
    customerDiscountAmount: digitsOf(values.customerDiscountAmount),
    commissionAmount: digitsOf(values.commissionAmount),
  };
}

/** @param {App} app */
export function partnersPanel(app) {
  const manage = app.state.profile?.permissions.includes('partner.manage') ?? false;
  const report = app.state.profile?.permissions.includes('commission.report') ?? false;
  const joins = (app.state.profile?.permissions.includes('partner.join_requests') && Boolean(app.state.profile?.activeRole?.tenantId)) ?? false;
  const joinSection = `
    <section class="card-sw" id="join-card" aria-labelledby="join-title" hidden>
      <h2 class="card-title d-flex align-items-center gap-2" id="join-title">
        <span>${esc(t('joinTitle'))}</span>
        <span class="count-badge" id="join-count"></span>
      </h2>
      <p class="small text-muted">${esc(t(manage ? 'joinHint' : 'joinHintManager'))}</p>
      ${messageSlot('join-message')}
      <div class="application-list mt-3" id="join-rows"></div>
    </section>`;
  const createSection = `
    <section class="card-sw" id="partner-create-card" hidden>
      <h2 class="card-title" id="partner-create-title">${esc(t('partnerCreateTitle'))}</h2>
      <p class="text-muted small mb-3" id="partner-create-subtitle">${esc(t('partnerCreateSubtitle'))}</p>
      <form id="partner-create" class="row g-3" novalidate>
        <div class="col-12 col-md-6">
          <label for="p-name" class="form-label small">${esc(t('partnerName'))}</label>
          <input id="p-name" name="name" class="form-control" maxlength="120" required />
        </div>
        <div class="col-12 col-md-6">
          <label for="p-type" class="form-label small">${esc(t('partnerType'))}</label>
          <select id="p-type" name="partnerType" class="form-select">
            ${PARTNER_TYPES.map((type) => `<option value="${type}">${esc(t(`ptype_${type}`))}</option>`).join('')}
          </select>
        </div>
        <fieldset class="col-12">
          <legend class="form-label small mb-2">${esc(t('relationshipKind'))}</legend>
          <div class="btn-group w-100" role="group" aria-label="${esc(t('relationshipKind'))}">
            ${KINDS.map(
              (kind, index) => `
              <input type="radio" class="btn-check" name="relationshipKind" id="p-kind-${kind}" value="${kind}"${index === 0 ? ' checked' : ''} />
              <label class="btn btn-outline-secondary" for="p-kind-${kind}">${esc(t(`kind_${kind}`))}</label>`,
            ).join('')}
          </div>
          <p class="small text-muted mt-2 mb-0" id="p-kind-hint">${esc(t('kindHint_COMPANY'))}</p>
        </fieldset>
        <fieldset class="col-12">
          <legend class="form-label small fw-semibold mb-2">${esc(t('ruleTitle'))}</legend>
          ${ruleFields('p-rule')}
        </fieldset>
        <div class="col-12 col-md-4">
          <label for="p-contact" class="form-label small">${optionalLabel(t('contactName'))}</label>
          <input id="p-contact" name="contactName" class="form-control" maxlength="120" />
        </div>
        <div class="col-12 col-md-4">
          <label for="p-phone" class="form-label small">${optionalLabel(t('contactPhone'))}</label>
          <input id="p-phone" name="contactPhone" type="tel" class="form-control" maxlength="32" />
        </div>
        <div class="col-12 col-md-4">
          <label for="p-email" class="form-label small">${optionalLabel(t('contactEmail'))}</label>
          <input id="p-email" name="contactEmail" type="email" class="form-control" maxlength="254" />
        </div>
        <div class="col-12">
          <label for="p-note" class="form-label small">${optionalLabel(t('note'))}</label>
          <input id="p-note" name="note" class="form-control" maxlength="500" />
        </div>
        <p class="col-12 small mb-0" id="p-join-account" hidden></p>
        <fieldset class="col-12" id="p-account">
          <legend class="form-label small fw-semibold mb-2">${optionalLabel(t('partnerAccount'))}</legend>
          <div class="row g-3">
            <div class="col-12 col-md-5">
              <label for="p-acc-name" class="form-label small">${esc(t('accountName'))}</label>
              <input id="p-acc-name" name="accountName" class="form-control" maxlength="120" />
            </div>
            <div class="col-8 col-md-5">
              <label for="p-acc-email" class="form-label small">${esc(t('email'))}</label>
              <input id="p-acc-email" name="accountEmail" type="email" class="form-control" maxlength="254" />
            </div>
            <div class="col-4 col-md-2">
              <label for="p-acc-lang" class="form-label small">${esc(t('language'))}</label>
              ${languageSelect('p-acc-lang')}
            </div>
          </div>
        </fieldset>
        <div class="col-12 d-flex flex-column flex-md-row gap-2">
          <button type="submit" class="btn btn-primary" id="partner-create-submit">${esc(t('partnerCreate'))}</button>
          <button type="button" class="btn btn-outline-secondary" data-create-close>${esc(t('cancel'))}</button>
        </div>
      </form>
      ${messageSlot('partner-create-message')}
    </section>`;
  return `
    ${joins ? joinSection : ''}
    ${report ? reportCard() : ''}
    <section class="card-sw" id="partner-list-card">
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h2 class="card-title mb-0">${esc(t('partnersTitle'))}</h2>
        <div class="d-flex gap-2 ms-auto">
          ${report ? `<button type="button" class="btn btn-outline-secondary btn-sm text-nowrap" id="partner-report-open" aria-controls="partner-report-card" aria-expanded="false">${esc(t('reportOpen'))}</button>` : ''}
          ${manage ? `<button type="button" class="btn btn-primary btn-sm text-nowrap" id="partner-create-open" aria-controls="partner-create-card" aria-expanded="false">+ ${esc(t('partnerCreate'))}</button>` : ''}
        </div>
      </div>
      ${messageSlot('partner-message')}
      <div id="partner-link" class="link-box mb-3" hidden></div>
      <div class="partner-list" id="partner-rows"></div>
    </section>
    ${manage ? createSection : ''}`;
}

/**
 * @param {string} message
 * @param {{ inviteUrl: string | null, expiresAt: string | null }} invitation
 * @param {string} name
 * @param {string} boxId
 * @param {string} slotId
 */
function showInvitation(message, invitation, name, boxId, slotId) {
  if (invitation.inviteUrl) {
    showLink(`${message} ${t('inviteLinkReady', { name, expires: formatDateTime(/** @type {string} */ (invitation.expiresAt)) })}`.trim(), invitation.inviteUrl, boxId);
    showMessage('', 'info', slotId);
  } else {
    $(`#${boxId}`).hidden = true;
    showMessage(`${message} ${t('roleGranted')}`.trim(), 'success', slotId);
  }
}

/**
 * A modal form; resolves when the dialog closes.
 * @param {{ title: string, body: string, submit: string, onReady?: (form: HTMLFormElement) => void,
 *   onSubmit: (form: HTMLFormElement) => Promise<void> }} options
 */
export function formDialog({ title, body, submit, onReady, onSubmit }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'vdialog';
  dialog.innerHTML = `
    <form class="vdialog-inner" novalidate>
      <button type="button" class="btn-close vdialog-close" data-close aria-label="${esc(t('close'))}"></button>
      <h2 class="h5 mb-3 pe-4">${esc(title)}</h2>
      ${body}
      ${messageSlot('dialog-message')}
      <div class="d-flex gap-2 mt-3">
        <button type="button" class="btn btn-outline-secondary flex-fill" data-close>${esc(t('cancel'))}</button>
        <button type="submit" class="btn btn-primary flex-fill">${esc(submit)}</button>
      </div>
    </form>`;
  const form = /** @type {HTMLFormElement} */ (dialog.querySelector('form'));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || /** @type {HTMLElement} */ (event.target).closest('[data-close]')) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(form, async () => {
      try {
        await onSubmit(form);
        dialog.close();
      } catch (error) {
        showMessage(errorText(error), 'error', 'dialog-message');
      }
    });
  });
  document.body.append(dialog);
  onReady?.(form);
  dialog.showModal();
  /** @type {HTMLElement | null} */ (form.querySelector('input'))?.focus();
}

/** @param {Partner} partner */
function qrOf(partner) {
  return {
    token: /** @type {NonNullable<Partner['qr']>} */ (partner.qr).token,
    merchantName: partner.merchantName ?? 'MyConnect',
    partnerName: partner.name,
    discount: ruleDiscount(partner.rule),
    brand: partner.brand ?? null,
  };
}

/**
 * The partner's QR to print or send, with a replace button for a lost or leaked one.
 * @param {Partner} partner
 * @param {{ manage: boolean, onReplaced: () => Promise<Partner | undefined> }} options
 */
function qrDialog(partner, { manage, onReplaced }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'vdialog';
  const draw = async (/** @type {Partner} */ current) => {
    const qr = qrOf(current);
    const link = referralLink(qr.token);
    dialog.innerHTML = `
      <div class="vdialog-inner">
        <button type="button" class="btn-close vdialog-close" data-close aria-label="${esc(t('close'))}"></button>
        <h2 class="h5 mb-1 pe-4">${esc(t('partnerQrTitle', { name: current.name }))}</h2>
        <p class="small text-muted">${esc(t('partnerQrHint'))}</p>
        ${current.status === 'PAUSED' ? `<p class="form-message" data-tone="error">${esc(t('partnerQrPaused'))}</p>` : ''}
        <div class="partner-qr"><img alt="QR ${esc(current.name)}" width="240" height="240" /></div>
        <p class="partner-qr-link small font-monospace text-center" translate="no" title="${esc(link)}">${esc(shortLink(link))}</p>
        <div class="vcard-actions">
          <button type="button" class="btn btn-primary" data-qr-share>${esc(t('share'))}</button>
          <button type="button" class="btn btn-outline-secondary" data-qr-download>${esc(t('downloadImage'))}</button>
          <button type="button" class="btn btn-outline-secondary" data-qr-copy>${esc(t('copyLink'))}</button>
        </div>
        ${messageSlot('qr-message')}
        ${
          manage
            ? `<hr class="my-3" />
               <p class="small text-muted mb-2">${esc(t('partnerQrReplaceHint'))}</p>
               <button type="button" class="btn btn-sm btn-outline-danger" data-qr-replace>${esc(t('partnerQrReplace'))}</button>`
            : ''
        }
      </div>`;
    /** @type {HTMLImageElement} */ (dialog.querySelector('.partner-qr img')).src = await referralQrDataUrl(qr.token, 480);
  };

  dialog.addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target === dialog || target.closest('[data-close]')) return dialog.close();
    const button = /** @type {HTMLButtonElement | null} */ (target.closest('button'));
    if (!button) return;
    const qr = qrOf(partner);
    try {
      if (button.hasAttribute('data-qr-share')) {
        button.disabled = true;
        const outcome = await sharePartnerQr(qr);
        if (outcome === 'downloaded') showMessage(t('imageDownloaded'), 'success', 'qr-message');
      } else if (button.hasAttribute('data-qr-download')) {
        button.disabled = true;
        downloadBlob(await partnerQrImage(qr), `qr-${qr.token.slice(0, 8)}.png`);
      } else if (button.hasAttribute('data-qr-copy')) {
        await navigator.clipboard.writeText(referralLink(qr.token));
        showMessage(t('copied'), 'success', 'qr-message');
      } else if (button.hasAttribute('data-qr-replace')) {
        if (!confirm(t('partnerQrReplaceConfirm', { name: partner.name }))) return;
        button.disabled = true;
        const updated = await onReplaced();
        if (updated?.qr) {
          partner = updated;
          await draw(partner);
          showMessage(t('partnerQrReplaced'), 'success', 'qr-message');
        }
      }
    } catch (error) {
      showMessage(errorText(error), 'error', 'qr-message');
    } finally {
      if (dialog.contains(button)) button.disabled = false;
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  draw(partner);
  dialog.showModal();
}

/**
 * Counts, and for roles that see commission: unpaid, paid, "Mark as paid", "Review bills" and "History".
 * @param {Partner} p
 * @param {{ settle: boolean, history: boolean }} options
 */
function partnerStatsLine(p, { settle, history }) {
  const stats = /** @type {NonNullable<Partner['stats']>} */ (p.stats);
  const money = stats.commissionOpen !== undefined;
  const unpaid = money && stats.commissionOpen !== '0.0000';
  const pending = stats.pendingReviews ?? 0;
  /** @param {string} label @param {string | number} value @param {string} [extra] */
  const stat = (label, value, extra = '') => `
      <div class="partner-stat${extra}"><dt>${esc(label)}</dt><dd>${esc(String(value))}</dd></div>`;
  const buttons = [
    settle && unpaid ? `<button type="button" class="btn btn-sm btn-primary" data-action="pay" data-id="${esc(p.id)}">${esc(t('markPaid'))}</button>` : '',
    settle && pending ? `<button type="button" class="btn btn-sm btn-outline-secondary" data-action="review" data-id="${esc(p.id)}">${esc(t('reviewOpen'))}</button>` : '',
    history && money ? `<button type="button" class="btn btn-sm btn-outline-secondary" data-action="history" data-id="${esc(p.id)}">${esc(t('historyButton'))}</button>` : '',
  ].join('');
  return `
    <dl class="partner-stats">
      ${stat(t('kpiOpens'), stats.opens)}
      ${stat(t('kpiActivations'), stats.activations)}
      ${stat(t('kpiRedemptions'), stats.redemptions)}
      ${money ? stat(t('commissionOwed'), formatVnd(stats.commissionOpen ?? '0'), ' is-money') : ''}
      ${money ? stat(t('commissionPaid'), formatVnd(stats.commissionPaid ?? '0'), ' is-money') : ''}
    </dl>
    ${pending ? `<p class="partner-pending small">${esc(t('commissionPendingLine', { amount: formatVnd(stats.commissionPending ?? '0'), count: pending }))}</p>` : ''}
    ${money && stats.lastPaidAt ? `<p class="small text-muted mb-0">${esc(t('lastPaid', { date: formatDateTime(stats.lastPaidAt) }))}</p>` : ''}
    ${buttons ? `<div class="partner-actions">${buttons}</div>` : ''}`;
}

/**
 * Contact details not already shown in the account list.
 * @param {Partner} p
 */
function extraContact(p) {
  const known = new Set(p.accounts.flatMap((a) => [a.displayName.trim().toLowerCase(), a.email.toLowerCase()]));
  return [p.contactName, p.contactPhone, p.contactEmail].filter((value) => value && !known.has(value.trim().toLowerCase())).join(' · ');
}

/**
 * Bills the guest could not confirm, with their photos; approve turns the commission into unpaid
 * commission, reject drops it.
 * @param {Partner} partner
 * @param {() => Promise<void>} onChanged
 */
async function reviewDialog(partner, onChanged) {
  const dialog = document.createElement('dialog');
  dialog.className = 'vdialog';
  const render = async () => {
    const { reviews } = await api('GET', `/api/v1/commission-reviews?partnerId=${encodeURIComponent(partner.id)}`);
    dialog.innerHTML = `
      <div class="vdialog-inner">
        <button type="button" class="btn-close vdialog-close" data-close aria-label="${esc(t('close'))}"></button>
        <h2 class="card-title">${esc(t('reviewTitle', { name: partner.name }))}</h2>
        <p class="small text-muted">${esc(t('reviewHint'))}</p>
        ${messageSlot('review-message')}
        ${
          reviews.length
            ? reviews
                .map(
                  (/** @type {any} */ r) => `
          <article class="review-item">
            <p class="small mb-1"><strong class="font-monospace" translate="no">${esc(r.voucher?.code ? formatVoucherCode(r.voucher.code) : '')}</strong> · ${esc(formatDateTime(r.createdAt))}</p>
            <p class="small mb-1">${esc(t('reviewBill', { bill: formatVnd(r.voucher?.redemption?.grossAmount ?? '0'), pays: formatVnd(r.voucher?.redemption?.payableAmount ?? '0') }))}</p>
            <p class="small mb-1">${esc(t('reviewReason', { reason: t(`fallback_${r.reason}`) }))} · ${esc(t('reviewCommission', { amount: formatVnd(r.amount) }))}</p>
            ${billPhotoList(r.voucher?.billPhotos ?? [])}
            <div class="partner-actions mt-2">
              <button type="button" class="btn btn-sm btn-primary" data-review="approve" data-id="${esc(r.id)}">${esc(t('reviewApprove'))}</button>
              <button type="button" class="btn btn-sm btn-outline-danger" data-review="reject" data-id="${esc(r.id)}">${esc(t('reviewReject'))}</button>
            </div>
          </article>`,
                )
                .join('')
            : `<p class="text-muted mb-0">${esc(t('reviewNone'))}</p>`
        }
      </div>`;
  };
  dialog.addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target === dialog || target.closest('[data-close]')) return dialog.close();
    const button = /** @type {HTMLButtonElement | null} */ (target.closest('button[data-review]'));
    if (!button) return;
    const decision = button.dataset.review;
    /** @type {{ note?: string }} */
    const body = {};
    if (decision === 'reject') {
      const note = prompt(t('reviewRejectPrompt'))?.trim();
      if (!note) return;
      body.note = note;
    }
    button.disabled = true;
    try {
      await api('POST', `/api/v1/commission-reviews/${encodeURIComponent(button.dataset.id ?? '')}/${decision}`, body);
      await onChanged();
      await render();
      showMessage(t(decision === 'approve' ? 'reviewApproved' : 'reviewRejected'), 'success', 'review-message');
    } catch (error) {
      button.disabled = false;
      showMessage(errorText(error), 'error', 'review-message');
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  await render();
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * Bills of one partner (unpaid, waiting, paid, voided) with voucher codes, then its payments.
 * @param {Partner} partner
 */
function historyDialog(partner) {
  const base = `/api/v1/partners/${encodeURIComponent(partner.id)}`;
  const dialog = openDialog(
    `
    <h2 class="h5 mb-3 pe-4">${esc(t('historyDialogTitle', { name: partner.name }))}</h2>
    <h3 class="card-title">${esc(t('historyBills'))}</h3>
    ${historyBlock('ph')}
    <h3 class="card-title mt-4">${esc(t('historyPayments'))}</h3>
    <ul class="payout-list" id="ph-payouts"></ul>`,
    { wide: true },
  );
  mountHistory(dialog, 'ph', {
    url: `${base}/history`,
    withCode: true,
    onFirstPage: (data) => {
      if (!data.payouts) return;
      /** @type {HTMLElement} */ (dialog.querySelector('#ph-payouts')).innerHTML = data.payouts.length
        ? data.payouts.map(payoutItem).join('')
        : `<li class="small text-muted">${esc(t('historyNoPayments'))}</li>`;
    },
  });
  dialog.querySelector('#ph-payouts')?.addEventListener('click', (event) => {
    const id = /** @type {HTMLElement} */ (event.target).closest('[data-payout]')?.getAttribute('data-payout');
    if (id) openPayout(`${base}/payouts/${encodeURIComponent(id)}`, true).catch((error) => showMessage(errorText(error), 'error', 'ph-message'));
  });
}

/**
 * @param {Partner} p
 * @param {{ manage: boolean, settle: boolean, history: boolean, showMerchant: boolean }} options
 */
function partnerCard(p, { manage, settle, history, showMerchant }) {
  const rule = p.rule
    ? `<p class="partner-terms small">
         <span class="fw-semibold">${esc(t('ruleShort', ruleTerms(p.rule)))}</span>
         <span class="pill pill-sm" title="${esc(t('ruleVersion', { version: p.rule.version }))}">v${p.rule.version}</span>
       </p>
       ${isFixedRule(p.rule) ? '' : `<p class="small text-muted mb-0">${esc(t('rulePercentNote'))}</p>`}`
    : '';
  const accounts = p.accounts.length
    ? p.accounts
        .map(
          (a) => `
        <div class="partner-account">
          <span class="partner-account-name">${esc(a.displayName)}</span>
          <span class="pill pill-sm pill-${esc(a.status.toLowerCase())}">${esc(t(`status_${a.status}`))}</span>
          <span class="partner-account-email text-muted" title="${esc(a.email)}">${esc(a.email)}</span>
        </div>`,
        )
        .join('')
    : `<span class="text-muted">${esc(t('noAccount'))}</span>`;
  const contact = extraContact(p);
  const qrButton = p.qr
    ? `<button type="button" class="btn btn-sm btn-outline-secondary" data-action="qr" data-id="${esc(p.id)}">${icon('qr')}<span>${esc(t('partnerQr'))}</span></button>`
    : '';
  const actions =
    manage && p.status !== 'ENDED'
      ? `<div class="partner-actions">
          ${qrButton}
          <button type="button" class="btn btn-sm btn-outline-secondary" data-action="rule" data-id="${esc(p.id)}">${esc(t('editRule'))}</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-action="invite" data-id="${esc(p.id)}">${esc(t('inviteAccount'))}</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-action="${p.status === 'ACTIVE' ? 'pause' : 'resume'}" data-id="${esc(p.id)}">
            ${esc(t(p.status === 'ACTIVE' ? 'pause' : 'resume'))}
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger" data-action="end" data-id="${esc(p.id)}">${esc(t('endPartner'))}</button>
        </div>`
      : qrButton
        ? `<div class="partner-actions">${qrButton}</div>`
        : '';
  return `
    <article class="partner-card${p.status === 'ENDED' ? ' is-ended' : ''}" id="partner-${esc(p.id)}">
      <header class="partner-head">
        <div>
          <h3 class="partner-name">${esc(p.name)}</h3>
          <p class="small text-muted mb-0">${esc(t(`ptype_${p.partnerType}`))} · ${esc(t(`kind_${p.relationshipKind}`))}${
            showMerchant && p.merchantName ? ` · ${esc(p.merchantName)}` : ''
          }</p>
        </div>
        <span class="pill pill-${esc(p.status.toLowerCase())}">${esc(t(`status_${p.status}`))}</span>
      </header>
      ${rule}
      ${p.stats ? partnerStatsLine(p, { settle, history }) : ''}
      ${contact ? `<p class="small text-muted mb-0">${esc(contact)}</p>` : ''}
      ${p.endReason ? `<p class="small text-muted mb-0">${esc(t('endPartner'))}: ${esc(p.endReason)}</p>` : ''}
      <div class="small partner-accounts"><span class="text-muted d-block mb-1">${esc(t('partnerAccounts'))}</span>${accounts}</div>
      ${actions}
    </article>`;
}

/**
 * @typedef {{ id: string, message: string | null, createdAt: string,
 *   profile: import('./partner-welcome.js').PartnerProfile }} JoinRequest
 */

/**
 * A partner asking to join: its profile and message; approve / reject for the Merchant admin.
 * @param {JoinRequest} r
 * @param {boolean} manage
 */
function joinCard(r, manage) {
  const p = r.profile;
  const facts = /** @type {Array<[string, string | null]>} */ ([
    [t('contactName'), p.relationshipKind === 'COMPANY' ? p.contactName : null],
    [t('email'), p.email],
    [t('contactPhone'), p.phone],
    [t('partnerNote'), p.note],
  ])
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`)
    .join('');
  return `
    <article class="application join-card" data-join="${esc(r.id)}">
      <div class="application-main">
        <h3 class="h6 mb-1">${esc(p.name)}</h3>
        <p class="small text-muted mb-0">${esc(t(`ptype_${p.partnerType}`))} · ${esc(t(`kind_${p.relationshipKind}`))}</p>
        <dl class="profile-facts">${facts}</dl>
        ${r.message ? `<p class="join-message small">${esc(t('joinMessage', { message: r.message }))}</p>` : ''}
        <p class="small text-muted mb-0">${esc(t('joinRequestedAt', { date: formatDateTime(r.createdAt) }))}</p>
      </div>
      ${
        manage
          ? `<div class="application-actions">
              <button type="button" class="btn btn-sm btn-primary" data-join-approve="${esc(r.id)}">${esc(t('approve'))}</button>
              <button type="button" class="btn btn-sm btn-outline-secondary" data-join-reject="${esc(r.id)}">${esc(t('reject'))}</button>
            </div>`
          : ''
      }
    </article>`;
}

/** @param {App} app */
export function mountPartners(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  const manage = profile.permissions.includes('partner.manage');
  const settle = profile.permissions.includes('commission.settle');
  const history = profile.permissions.includes('commission.list');
  const report = profile.permissions.includes('commission.report');
  const showMerchant = !profile.activeRole?.tenantId;
  /** @type {Partner[]} */
  let partners = [];
  /** @type {JoinRequest[]} */
  let joinRequests = [];
  /** The join request being approved with the add-partner form, if any. @type {JoinRequest | null} */
  let approving = null;

  const loadJoins = async () => {
    const card = document.getElementById('join-card');
    if (!card) return;
    try {
      joinRequests = (await api('GET', '/api/v1/merchant/join-requests')).requests;
      card.hidden = joinRequests.length === 0;
      $('#join-count').textContent = String(joinRequests.length);
      $('#join-rows').innerHTML = joinRequests.map((r) => joinCard(r, manage)).join('');
    } catch (error) {
      card.hidden = false;
      showMessage(errorText(error), 'error', 'join-message');
    }
  };

  const renderRows = () => {
    $('#partner-rows').innerHTML = partners.length
      ? partners.map((p) => partnerCard(p, { manage, settle, history, showMerchant })).join('')
      : `<p class="text-muted mb-0">${esc(t('noPartners'))}</p>`;
  };

  /** From the Overview work list: /console/partners?partner=<id> brings that card into view. */
  const showTarget = () => {
    const id = new URLSearchParams(location.search).get('partner');
    const card = id ? document.getElementById(`partner-${id}`) : null;
    if (!card) return;
    card.classList.add('is-target');
    card.scrollIntoView({ block: 'center' });
  };

  /** @param {boolean} open */
  const setCreateOpen = (open) => {
    const card = $('#partner-create-card');
    if (!card) return;
    card.hidden = !open;
    $('#partner-create-open').setAttribute('aria-expanded', String(open));
    if (open) {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#p-name').focus({ preventScroll: true });
    }
  };

  let firstLoad = true;
  const load = async () => {
    try {
      partners = (await api('GET', '/api/v1/partners')).partners;
      renderRows();
      if (firstLoad && manage && !partners.length) $('#partner-create-card').hidden = false;
      if (firstLoad) showTarget();
      firstLoad = false;
    } catch (error) {
      showMessage(errorText(error), 'error', 'partner-message');
    }
  };

  if (report) {
    const openButton = $('#partner-report-open');
    const setReportOpen = mountReport(app.root, { onToggle: (open) => openButton.setAttribute('aria-expanded', String(open)) });
    openButton.addEventListener('click', () => setReportOpen(true));
    if (new URLSearchParams(location.search).get('view') === 'report') setReportOpen(true);
  }

  if (manage) {
    const createForm = /** @type {HTMLFormElement} */ ($('#partner-create'));
    const kindOf = () => formValues(createForm).relationshipKind || 'COMPANY';

    const resetCreateForm = () => {
      createForm.reset();
      $('#p-kind-hint').textContent = t('kindHint_COMPANY');
      createForm.dispatchEvent(new Event('input'));
    };

    /**
     * Approving a join request reuses the add-partner form: prefilled from the profile, without the
     * account fields (the role goes to the requester's own account).
     * @param {JoinRequest | null} request
     */
    const setApproving = (request) => {
      approving = request;
      resetCreateForm();
      $('#partner-create-title').textContent = request ? t('joinApproveTitle', { name: request.profile.name }) : t('partnerCreateTitle');
      $('#partner-create-subtitle').textContent = t(request ? 'joinApproveSubtitle' : 'partnerCreateSubtitle');
      $('#partner-create-submit').textContent = request ? t('joinApproveSubmit') : t('partnerCreate');
      $('#p-account').hidden = Boolean(request);
      const accountLine = $('#p-join-account');
      accountLine.hidden = !request;
      accountLine.textContent = request ? t('joinAccountLine', { email: request.profile.email }) : '';
      showMessage('', 'info', 'partner-create-message');
      if (!request) return;
      const p = request.profile;
      const field = (/** @type {string} */ name) => /** @type {HTMLInputElement} */ (createForm.elements.namedItem(name));
      field('name').value = p.name;
      field('partnerType').value = p.partnerType;
      /** @type {HTMLInputElement} */ ($(`#p-kind-${p.relationshipKind}`, createForm)).checked = true;
      $('#p-kind-hint').textContent = t(`kindHint_${p.relationshipKind}`);
      field('contactName').value = p.contactName ?? (p.relationshipKind === 'COMPANY' ? '' : p.name);
      field('contactPhone').value = p.phone ?? '';
      field('contactEmail').value = p.email;
      createForm.dispatchEvent(new Event('input'));
    };

    $('#partner-create-open').addEventListener('click', () => {
      if (approving) setApproving(null);
      setCreateOpen(true);
    });
    $('[data-create-close]').addEventListener('click', () => {
      if (approving) setApproving(null);
      setCreateOpen(false);
      $('#partner-list-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    bindRulePreview(createForm, 'p-rule', kindOf);
    createForm.addEventListener('change', (event) => {
      if (/** @type {HTMLInputElement} */ (event.target).name === 'relationshipKind') $('#p-kind-hint').textContent = t(`kindHint_${kindOf()}`);
    });
    createForm.addEventListener('submit', (event) => {
      event.preventDefault();
      busy(createForm, async () => {
        showMessage('', 'info', 'partner-create-message');
        showMessage('', 'info', 'partner-message');
        $('#partner-link').hidden = true;
        const values = formValues(createForm);
        const fields = {
          name: values.name,
          relationshipKind: kindOf(),
          partnerType: values.partnerType,
          contactName: values.contactName,
          contactPhone: values.contactPhone,
          contactEmail: values.contactEmail,
          note: values.note,
          rule: rulePayload(createForm),
        };
        try {
          if (approving) {
            const result = await api('POST', `/api/v1/merchant/join-requests/${encodeURIComponent(approving.id)}/approve`, fields);
            const approved = t('joinApproved', { name: result.partner.name });
            showMessage(result.emailSent ? approved : `${approved} ${t('joinEmailNotSent')}`, result.emailSent ? 'success' : 'info', 'partner-message');
            setApproving(null);
            setCreateOpen(false);
            await Promise.all([load(), loadJoins()]);
            $('#partner-list-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
          const withAccount = Boolean(values.accountEmail.trim() || values.accountName.trim());
          const result = await api('POST', '/api/v1/partners', {
            ...fields,
            ...(withAccount
              ? { account: { email: values.accountEmail, displayName: values.accountName, preferredLanguage: values.preferredLanguage } }
              : {}),
          });
          const created = t('partnerCreated', { name: result.partner.name });
          if (result.invitation) showInvitation(created, result.invitation, values.accountName, 'partner-link', 'partner-message');
          else showMessage(created, 'success', 'partner-message');
          resetCreateForm();
          setCreateOpen(false);
          await load();
          $('#partner-list-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (error) {
          showMessage(errorText(error), 'error', 'partner-create-message');
        }
      });
    });

    document.getElementById('join-rows')?.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const approveId = target.closest('[data-join-approve]')?.getAttribute('data-join-approve');
      const rejectId = target.closest('[data-join-reject]')?.getAttribute('data-join-reject');
      const request = joinRequests.find((r) => r.id === (approveId ?? rejectId));
      if (!request) return;
      if (approveId) {
        setApproving(request);
        setCreateOpen(true);
        return;
      }
      formDialog({
        title: t('joinRejectTitle', { name: request.profile.name }),
        body: `
          <label for="d-join-reason" class="form-label small">${optionalLabel(t('joinRejectReason'))}</label>
          <textarea id="d-join-reason" name="reason" class="form-control" rows="3" maxlength="500"></textarea>`,
        submit: t('reject'),
        onSubmit: async (form) => {
          const result = await api('POST', `/api/v1/merchant/join-requests/${encodeURIComponent(request.id)}/reject`, { reason: formValues(form).reason });
          const rejected = t('joinRejected', { name: request.profile.name });
          const text = result.emailSent ? rejected : `${rejected} ${t('joinEmailNotSent')}`;
          if (approving?.id === request.id) {
            setApproving(null);
            setCreateOpen(false);
          }
          await loadJoins();
          showMessage(text, result.emailSent ? 'success' : 'info', joinRequests.length ? 'join-message' : 'partner-message');
        },
      });
    });
  }

  $('#partner-rows').addEventListener('click', async (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('button[data-action]');
    if (!button) return;
    const partner = partners.find((p) => p.id === button.getAttribute('data-id'));
    if (!partner) return;
    const path = `/api/v1/partners/${encodeURIComponent(partner.id)}`;
    const action = button.getAttribute('data-action');

    if (action === 'review') {
      reviewDialog(partner, load).catch((error) => showMessage(errorText(error), 'error', 'partner-message'));
      return;
    }

    if (action === 'history') {
      historyDialog(partner);
      return;
    }

    if (action === 'pay') {
      const amount = formatVnd(partner.stats?.commissionOpen ?? '0');
      formDialog({
        title: t('markPaidTitle', { name: partner.name }),
        body: `
          <p class="small">${esc(t('markPaidConfirm', { name: partner.name, amount }))}</p>
          <label for="d-pay-note" class="form-label small">${optionalLabel(t('markPaidNote'))}</label>
          <textarea id="d-pay-note" name="note" class="form-control" rows="2" maxlength="300"></textarea>
          <p class="small text-muted mt-1 mb-0">${esc(t('markPaidNoteHint'))}</p>`,
        submit: t('markPaid'),
        onSubmit: async (form) => {
          const { payout } = await api('POST', `${path}/payouts`, { note: formValues(form).note });
          showMessage(t('markPaidDone', { name: partner.name, amount: formatVnd(payout.amount) }), 'success', 'partner-message');
          await load();
        },
      });
      return;
    }

    if (action === 'qr') {
      qrDialog(partner, {
        manage,
        onReplaced: async () => {
          const result = await api('POST', `${path}/qr/replace`, {});
          await load();
          return result.partner;
        },
      });
      return;
    }

    if (action === 'rule') {
      const rule = partner.rule;
      formDialog({
        title: t('editRuleTitle', { name: partner.name }),
        body: `${ruleFields('d-rule', rule)}
          <p class="small text-muted mt-3 mb-0">${esc(t('ruleChangeNote'))}</p>`,
        submit: t('saveBtn'),
        onReady: (form) => bindRulePreview(form, 'd-rule', () => partner.relationshipKind),
        onSubmit: async (form) => {
          const result = await api('POST', `${path}/rule`, rulePayload(form));
          showMessage(t('ruleSaved', { version: result.partner.rule.version, name: partner.name }), 'success', 'partner-message');
          await load();
        },
      });
      return;
    }

    if (action === 'invite') {
      formDialog({
        title: t('inviteAccountTitle', { name: partner.name }),
        body: `
          <p class="small text-muted">${esc(t(`kindHint_${partner.relationshipKind}`))}</p>
          <div class="mb-3">
            <label for="d-acc-name" class="form-label small">${esc(t('accountName'))}</label>
            <input id="d-acc-name" name="displayName" class="form-control" maxlength="120" value="${esc(partner.contactName ?? '')}" required />
          </div>
          <div class="row g-3">
            <div class="col-8">
              <label for="d-acc-email" class="form-label small">${esc(t('email'))}</label>
              <input id="d-acc-email" name="email" type="email" class="form-control" maxlength="254" value="${esc(partner.contactEmail ?? '')}" required />
            </div>
            <div class="col-4">
              <label for="d-acc-lang" class="form-label small">${esc(t('language'))}</label>
              ${languageSelect('d-acc-lang')}
            </div>
          </div>`,
        submit: t('inviteSend'),
        onSubmit: async (form) => {
          const values = formValues(form);
          const result = await api('POST', `${path}/invitations`, values);
          showInvitation('', result, values.displayName, 'partner-link', 'partner-message');
          $('#partner-list-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
          await load();
        },
      });
      return;
    }

    try {
      if (action === 'pause') {
        if (!confirm(t('partnerPauseConfirm', { name: partner.name }))) return;
        await api('POST', `${path}/status`, { status: 'PAUSED' });
      } else if (action === 'resume') {
        await api('POST', `${path}/status`, { status: 'ACTIVE' });
      } else if (action === 'end') {
        const reason = prompt(t('endReasonPrompt', { name: partner.name }))?.trim();
        if (!reason) return;
        await api('POST', `${path}/status`, { status: 'ENDED', reason });
      }
      await load();
    } catch (error) {
      showMessage(errorText(error), 'error', 'partner-message');
    }
  });

  load();
  loadJoins();
}
