import { commercialRuleFromPercents, PARTNER_TYPES, ratePercent } from '#domain';
import { api } from '../api.js';
import { $, busy, esc, formValues } from '../dom.js';
import { errorText, formatDateTime, formatVnd, getLang, t } from '../i18n.js';
import { downloadBlob, partnerQrImage, referralLink, referralQrDataUrl, sharePartnerQr } from '../voucher-ui.js';
import { icon } from '../nav.js';
import { messageSlot, showLink, showMessage } from './common.js';

/** @typedef {import('../main.js').App} App */
/**
 * @typedef {{
 *   id: string, merchantId: string, merchantName: string | null, name: string,
 *   relationshipKind: 'COMPANY' | 'INDEPENDENT_INDIVIDUAL', partnerType: string,
 *   status: 'ACTIVE' | 'PAUSED' | 'ENDED', contactName: string | null, contactPhone: string | null,
 *   contactEmail: string | null, note: string | null, createdAt: string, endReason: string | null,
 *   rule: null | { version: number, totalBudgetRate: string, customerDiscountRate: string,
 *     companyCommissionRate: string | null, individualCommissionRate: string | null },
 *   accounts: { id: string, email: string, displayName: string, status: string, role: string }[],
 *   qr: null | { token: string, createdAt: string },
 *   brand?: import('../voucher-ui.js').Brand | null,
 *   stats?: { opens: number, activations: number, redemptions: number, commissionOpen?: string },
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

/** @param {NonNullable<Partner['rule']>} rule */
function commissionRate(rule) {
  return /** @type {string} */ (rule.companyCommissionRate ?? rule.individualCommissionRate);
}

/**
 * Two percent inputs and a live explanation of the split.
 * @param {string} prefix
 * @param {{ total?: string, discount?: string }} [values]
 */
function ruleFields(prefix, values = {}) {
  return `
    <div class="row g-3">
      <div class="col-6">
        <label for="${prefix}-total" class="form-label small">${esc(t('totalBudget'))}</label>
        <input id="${prefix}-total" name="totalBudgetPercent" class="form-control" inputmode="decimal" maxlength="6"
          value="${esc(values.total ?? '')}" placeholder="15" required />
      </div>
      <div class="col-6">
        <label for="${prefix}-discount" class="form-label small">${esc(t('customerDiscount'))}</label>
        <input id="${prefix}-discount" name="customerDiscountPercent" class="form-control" inputmode="decimal" maxlength="6"
          value="${esc(values.discount ?? '')}" placeholder="7" required />
      </div>
    </div>
    <p class="rule-preview small mt-2 mb-0" id="${prefix}-preview" aria-live="polite">${esc(t('ruleHint'))}</p>`;
}

/**
 * @param {HTMLFormElement} form
 * @param {string} prefix
 * @param {() => string} kindOf
 */
function bindRulePreview(form, prefix, kindOf) {
  const preview = $(`#${prefix}-preview`, form);
  const update = () => {
    const values = formValues(form);
    const total = values.totalBudgetPercent.replace(',', '.').trim();
    const discount = values.customerDiscountPercent.replace(',', '.').trim();
    if (!total || !discount) {
      preview.textContent = t('ruleHint');
      preview.dataset.tone = 'info';
      return;
    }
    const { rule, errors } = commercialRuleFromPercents({ relationshipKind: kindOf(), totalBudgetPercent: total, customerDiscountPercent: discount });
    if (rule) {
      preview.textContent = t('rulePreview', {
        discount: ratePercent(rule.customerDiscountRate),
        commission: ratePercent(/** @type {string} */ (rule.companyCommissionRate ?? rule.individualCommissionRate)),
      });
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
  return {
    totalBudgetPercent: values.totalBudgetPercent.replace(',', '.').trim(),
    customerDiscountPercent: values.customerDiscountPercent.replace(',', '.').trim(),
  };
}

/** @param {App} app */
export function partnersPanel(app) {
  const manage = app.state.profile?.permissions.includes('partner.manage') ?? false;
  const vatSection = `
    <section class="card-sw" id="vat-card">
      <h2 class="card-title">${esc(t('vatTitle'))}</h2>
      <p class="text-muted small mb-3">${esc(t('vatHint'))}</p>
      <form id="vat-form" class="row g-2 align-items-end" novalidate>
        <div class="col-6 col-md-3">
          <label for="vat" class="form-label small">${esc(t('vatPercent'))}</label>
          <input id="vat" name="vatPercent" class="form-control" inputmode="decimal" maxlength="6" placeholder="8" required />
        </div>
        <div class="col-6 col-md-3 d-grid">
          <button type="submit" class="btn btn-outline-secondary">${esc(t('vatSave'))}</button>
        </div>
      </form>
      ${messageSlot('vat-message')}
    </section>`;
  const createSection = `
    <section class="card-sw" id="partner-create-card" hidden>
      <h2 class="card-title">${esc(t('partnerCreateTitle'))}</h2>
      <p class="text-muted small mb-3">${esc(t('partnerCreateSubtitle'))}</p>
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
        <fieldset class="col-12">
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
          <button type="submit" class="btn btn-primary">${esc(t('partnerCreate'))}</button>
          <button type="button" class="btn btn-outline-secondary" data-create-close>${esc(t('cancel'))}</button>
        </div>
      </form>
      ${messageSlot('partner-create-message')}
    </section>`;
  return `
    <section class="card-sw" id="partner-list-card">
      <div class="d-flex justify-content-between align-items-center gap-2 mb-3">
        <h2 class="card-title mb-0">${esc(t('partnersTitle'))}</h2>
        ${manage ? `<button type="button" class="btn btn-primary btn-sm" id="partner-create-open" aria-controls="partner-create-card" aria-expanded="false">+ ${esc(t('partnerCreate'))}</button>` : ''}
      </div>
      ${messageSlot('partner-message')}
      <div id="partner-link" class="link-box mb-3" hidden></div>
      <div class="partner-list" id="partner-rows"></div>
    </section>
    ${manage ? createSection + vatSection : ''}`;
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
function formDialog({ title, body, submit, onReady, onSubmit }) {
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
    discountRate: partner.rule?.customerDiscountRate ?? null,
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
        <p class="partner-qr-link small font-monospace text-center" translate="no">${esc(link)}</p>
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

/** @param {NonNullable<Partner['stats']>} stats */
function partnerStatsLine(stats) {
  const counts = t('partnerCounts', { opens: stats.opens, activations: stats.activations, redemptions: stats.redemptions });
  return `
    <p class="small mb-1 partner-stats">
      <span class="text-muted">${esc(counts)}</span>
      ${stats.commissionOpen !== undefined ? `<span class="d-block">${esc(t('commissionOwed'))}: <strong>${esc(formatVnd(stats.commissionOpen))}</strong></span>` : ''}
    </p>`;
}

/**
 * @param {Partner} p
 * @param {{ manage: boolean, showMerchant: boolean }} options
 */
function partnerCard(p, { manage, showMerchant }) {
  const rule = p.rule
    ? `<span class="fw-semibold">${esc(t('ruleShort', { discount: ratePercent(p.rule.customerDiscountRate), commission: ratePercent(commissionRate(p.rule)) }))}</span>
       <span class="text-muted"> · ${esc(t('ruleVersion', { version: p.rule.version }))}</span>`
    : '';
  const accounts = p.accounts.length
    ? p.accounts
        .map((a) => `<span class="d-block">${esc(a.displayName)} <span class="text-muted">· ${esc(a.email)} · ${esc(t(`status_${a.status}`))}</span></span>`)
        .join('')
    : `<span class="text-muted">${esc(t('noAccount'))}</span>`;
  const contact = [p.contactName, p.contactPhone, p.contactEmail].filter(Boolean).join(' · ');
  const qrButton = p.qr
    ? `<button type="button" class="btn btn-sm btn-outline-primary" data-action="qr" data-id="${esc(p.id)}">${icon('qr')}<span>${esc(t('partnerQr'))}</span></button>`
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
    <article class="partner-card${p.status === 'ENDED' ? ' is-ended' : ''}">
      <header class="partner-head">
        <div>
          <h3 class="partner-name">${esc(p.name)}</h3>
          <p class="small text-muted mb-0">${esc(t(`ptype_${p.partnerType}`))} · ${esc(t(`kind_${p.relationshipKind}`))}${
            showMerchant && p.merchantName ? ` · ${esc(p.merchantName)}` : ''
          }</p>
        </div>
        <span class="pill pill-${esc(p.status.toLowerCase())}">${esc(t(`status_${p.status}`))}</span>
      </header>
      ${rule ? `<p class="small mb-1">${rule}</p>` : ''}
      ${p.stats ? partnerStatsLine(p.stats) : ''}
      ${contact ? `<p class="small text-muted mb-1">${esc(contact)}</p>` : ''}
      ${p.endReason ? `<p class="small text-muted mb-1">${esc(t('endPartner'))}: ${esc(p.endReason)}</p>` : ''}
      <div class="small partner-accounts"><span class="text-muted d-block">${esc(t('partnerAccounts'))}</span>${accounts}</div>
      ${actions}
    </article>`;
}

/** @param {App} app */
export function mountPartners(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  const manage = profile.permissions.includes('partner.manage');
  const showMerchant = !profile.activeRole?.tenantId;
  /** @type {Partner[]} */
  let partners = [];

  const renderRows = () => {
    $('#partner-rows').innerHTML = partners.length
      ? partners.map((p) => partnerCard(p, { manage, showMerchant })).join('')
      : `<p class="text-muted mb-0">${esc(t('noPartners'))}</p>`;
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
      firstLoad = false;
    } catch (error) {
      showMessage(errorText(error), 'error', 'partner-message');
    }
  };

  if (manage) {
    $('#partner-create-open').addEventListener('click', () => setCreateOpen(true));
    $('[data-create-close]').addEventListener('click', () => {
      setCreateOpen(false);
      $('#partner-list-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    const vatForm = /** @type {HTMLFormElement} */ ($('#vat-form'));
    const vatInput = /** @type {HTMLInputElement} */ ($('#vat'));
    api('GET', '/api/v1/merchant/settings')
      .then(({ vatRate }) => {
        if (vatRate) {
          vatInput.value = ratePercent(vatRate);
          showMessage(t('vatCurrent', { rate: ratePercent(vatRate) }), 'info', 'vat-message');
        } else {
          // Nothing can be added until VAT is set, so it comes first.
          $('#partner-list-card').before($('#vat-card'));
          showMessage(t('vatNotSet'), 'error', 'vat-message');
        }
      })
      .catch((error) => showMessage(errorText(error), 'error', 'vat-message'));
    vatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      busy(vatForm, async () => {
        try {
          const { vatRate } = await api('POST', '/api/v1/merchant/settings', { vatPercent: vatInput.value.replace(',', '.').trim() });
          vatInput.value = ratePercent(vatRate);
          showMessage(t('vatSaved', { rate: ratePercent(vatRate) }), 'success', 'vat-message');
        } catch (error) {
          showMessage(errorText(error), 'error', 'vat-message');
        }
      });
    });

    const createForm = /** @type {HTMLFormElement} */ ($('#partner-create'));
    const kindOf = () => formValues(createForm).relationshipKind || 'COMPANY';
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
        const withAccount = Boolean(values.accountEmail.trim() || values.accountName.trim());
        try {
          const result = await api('POST', '/api/v1/partners', {
            name: values.name,
            relationshipKind: kindOf(),
            partnerType: values.partnerType,
            contactName: values.contactName,
            contactPhone: values.contactPhone,
            contactEmail: values.contactEmail,
            note: values.note,
            rule: rulePayload(createForm),
            ...(withAccount
              ? { account: { email: values.accountEmail, displayName: values.accountName, preferredLanguage: values.preferredLanguage } }
              : {}),
          });
          const created = t('partnerCreated', { name: result.partner.name });
          if (result.invitation) showInvitation(created, result.invitation, values.accountName, 'partner-link', 'partner-message');
          else showMessage(created, 'success', 'partner-message');
          createForm.reset();
          $('#p-kind-hint').textContent = t('kindHint_COMPANY');
          createForm.dispatchEvent(new Event('input'));
          setCreateOpen(false);
          await load();
          $('#partner-list-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (error) {
          showMessage(errorText(error), 'error', 'partner-create-message');
        }
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
        body: `${ruleFields('d-rule', rule ? { total: ratePercent(rule.totalBudgetRate), discount: ratePercent(rule.customerDiscountRate) } : {})}
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
}
