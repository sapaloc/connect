import { api } from '../api.js';
import { $, busy, esc, formValues } from '../dom.js';
import { errorText, formatDate, formatDateTime, getLang, t } from '../i18n.js';
import { prepareLogo } from '../image.js';
import { messageSlot, showLink, showMessage } from './common.js';
import { openDialog } from './history.js';

/** @typedef {import('../main.js').App} App */
/**
 * @typedef {{
 *   id: string, name: string, slug: string | null, status: 'ACTIVE' | 'PAUSED',
 *   contactEmail: string | null, contactPhone: string | null, address: string | null,
 *   createdAt: string, admins: number, members: number, brand: import('../voucher-ui.js').Brand | null,
 *   awaitingFirstSignIn: Array<{ userId: string, email: string, expiresAt: string | null }>,
 * }} Merchant
 * @typedef {{
 *   id: string, name: string, slug: string, contactEmail: string | null, contactPhone: string | null, address: string | null,
 *   admin: { email: string, displayName: string, preferredLanguage: 'en' | 'vi' }, createdAt: string,
 * }} Application
 */

/** @param {string} id */
function languageSelect(id) {
  return `
    <select id="${id}" name="preferredLanguage" class="form-select">
      <option value="en"${getLang() === 'en' ? ' selected' : ''}>EN</option>
      <option value="vi"${getLang() === 'vi' ? ' selected' : ''}>VI</option>
    </select>`;
}

/** @param {string} label */
const optionalLabel = (label) => `${esc(label)} <span class="text-muted">(${esc(t('optional'))})</span>`;

export function merchantsPanel() {
  return `
    <section class="card-sw" id="applications" aria-labelledby="applications-title">
      <h2 class="card-title d-flex align-items-center gap-2" id="applications-title">
        <span>${esc(t('applicationsTitle'))}</span>
        <span class="count-badge" id="applications-count" hidden></span>
      </h2>
      <div id="application-list" class="application-list"></div>
      ${messageSlot('application-message')}
    </section>
    <section class="card-sw">
      <h2 class="card-title">${esc(t('merchantCreateTitle'))}</h2>
      <p class="text-muted small mb-3">${esc(t('merchantCreateSubtitle'))}</p>
      <form id="merchant-create" class="row g-3" novalidate>
        <div class="col-12 col-md-6">
          <label for="m-name" class="form-label small">${esc(t('merchantName'))}</label>
          <input id="m-name" name="name" class="form-control" maxlength="120" required />
        </div>
        <div class="col-12 col-md-6">
          <label for="m-phone" class="form-label small">${optionalLabel(t('contactPhone'))}</label>
          <input id="m-phone" name="contactPhone" type="tel" class="form-control" maxlength="32" />
        </div>
        <div class="col-12 col-md-6">
          <label for="m-email" class="form-label small">${optionalLabel(t('contactEmail'))}</label>
          <input id="m-email" name="contactEmail" type="email" class="form-control" maxlength="254" />
        </div>
        <div class="col-12 col-md-6">
          <label for="m-address" class="form-label small">${optionalLabel(t('address'))}</label>
          <input id="m-address" name="address" class="form-control" maxlength="300" />
        </div>
        <fieldset class="col-12">
          <legend class="form-label small fw-semibold mb-2">${optionalLabel(t('firstAdmin'))}</legend>
          <div class="row g-3">
            <div class="col-12 col-md-5">
              <label for="m-admin-name" class="form-label small">${esc(t('adminName'))}</label>
              <input id="m-admin-name" name="adminName" class="form-control" maxlength="120" />
            </div>
            <div class="col-8 col-md-5">
              <label for="m-admin-email" class="form-label small">${esc(t('adminEmail'))}</label>
              <input id="m-admin-email" name="adminEmail" type="email" class="form-control" maxlength="254" />
            </div>
            <div class="col-4 col-md-2">
              <label for="m-admin-lang" class="form-label small">${esc(t('language'))}</label>
              ${languageSelect('m-admin-lang')}
            </div>
          </div>
        </fieldset>
        <div class="col-12 col-md-4 d-grid">
          <button type="submit" class="btn btn-primary">${esc(t('merchantCreate'))}</button>
        </div>
      </form>
      ${messageSlot('merchant-message')}
      <div id="merchant-link" class="link-box" hidden></div>
    </section>
    <section class="card-sw" id="invite-admin">
      <h2 class="card-title">${esc(t('merchantInviteTitle'))}</h2>
      <form id="merchant-invite" class="row g-3 align-items-end" novalidate>
        <div class="col-12 col-md-6 col-xl-3">
          <label for="i-merchant" class="form-label small">${esc(t('nav_merchants'))}</label>
          <select id="i-merchant" name="tenantId" class="form-select" required></select>
        </div>
        <div class="col-12 col-md-6 col-xl-3">
          <label for="i-name" class="form-label small">${esc(t('adminName'))}</label>
          <input id="i-name" name="displayName" class="form-control" maxlength="120" required />
        </div>
        <div class="col-8 col-md-6 col-xl-3">
          <label for="i-email" class="form-label small">${esc(t('adminEmail'))}</label>
          <input id="i-email" name="email" type="email" class="form-control" maxlength="254" required />
        </div>
        <div class="col-4 col-md-2 col-xl-1">
          <label for="i-lang" class="form-label small">${esc(t('language'))}</label>
          ${languageSelect('i-lang')}
        </div>
        <div class="col-12 col-md-4 col-xl-2 d-grid">
          <button type="submit" class="btn btn-primary">${esc(t('inviteSend'))}</button>
        </div>
      </form>
      ${messageSlot('invite-message')}
      <div id="invite-link" class="link-box" hidden></div>
    </section>
    <section class="card-sw">
      <h2 class="card-title">${esc(t('merchantsTitle'))}</h2>
      <div class="table-responsive">
        <table class="table tbl tbl-stack align-middle mb-0">
          <thead>
            <tr>
              <th>${esc(t('merchantName'))}</th>
              <th>${esc(t('merchantPeople'))}</th>
              <th>${esc(t('status'))}</th>
              <th>${esc(t('createdAt'))}</th>
              <th class="text-end">${esc(t('actions'))}</th>
            </tr>
          </thead>
          <tbody id="merchant-rows"></tbody>
        </table>
      </div>
    </section>`;
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
    showLink(`${message} ${t('inviteLinkReady', { name, expires: formatDateTime(/** @type {string} */ (invitation.expiresAt)) })}`, invitation.inviteUrl, boxId);
    showMessage('', 'info', slotId);
  } else {
    $(`#${boxId}`).hidden = true;
    showMessage(`${message} ${t('roleGranted')}`.trim(), 'success', slotId);
  }
}

/**
 * Sign-in email, temporary password (shown once, with a copy button) and its expiry.
 * @param {HTMLDialogElement} dialog
 * @param {{ title: string, intro: string, email: string, temporaryPassword: string, expiresAt: string }} content
 */
function showCredentials(dialog, { title, intro, email, temporaryPassword, expiresAt }) {
  const inner = /** @type {HTMLElement} */ (dialog.querySelector('.vdialog-inner'));
  inner.innerHTML = `
    <button type="button" class="btn-close vdialog-close" data-close aria-label="${esc(t('close'))}"></button>
    <h2 class="h5 mb-2 pe-4">${esc(title)}</h2>
    <p class="small mb-3">${esc(intro)}</p>
    <dl class="credentials mb-3">
      <dt>${esc(t('signInEmail'))}</dt>
      <dd class="text-break">${esc(email)}</dd>
      <dt>${esc(t('temporaryPassword'))}</dt>
      <dd>
        <div class="input-group">
          <input class="form-control temp-password" readonly value="${esc(temporaryPassword)}" aria-label="${esc(t('temporaryPassword'))}" />
          <button type="button" class="btn btn-outline-secondary" data-copy-password>${esc(t('copy'))}</button>
        </div>
      </dd>
      <dt>${esc(t('expires'))}</dt>
      <dd>${esc(formatDateTime(expiresAt))}</dd>
    </dl>
    <p class="small text-muted mb-3">${esc(t('temporaryPasswordOnce'))}</p>
    <button type="button" class="btn btn-primary w-100" data-close>${esc(t('done'))}</button>`;
  const copy = /** @type {HTMLButtonElement} */ (inner.querySelector('[data-copy-password]'));
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(temporaryPassword);
    copy.textContent = t('copied');
  });
}

/** @param {App} _app */
export function mountMerchants(_app) {
  /** @type {Merchant[]} */
  let merchants = [];
  /** @type {Application[]} */
  let applications = [];

  const renderApplications = () => {
    const count = $('#applications-count');
    count.hidden = applications.length === 0;
    count.textContent = String(applications.length);
    $('#application-list').innerHTML = applications.length
      ? applications
          .map(
            (a) => `
        <article class="application" data-application="${esc(a.id)}">
          <div class="application-main">
            <h3 class="h6 mb-1">${esc(a.name)}</h3>
            <p class="small text-muted mb-1 text-break">${esc([a.contactPhone, a.contactEmail, a.address].filter(Boolean).join(' · ') || a.slug)}</p>
            <p class="small mb-1 text-break">${esc(t('applicationAdmin', { name: a.admin.displayName, email: a.admin.email, lang: a.admin.preferredLanguage.toUpperCase() }))}</p>
            <p class="small text-muted mb-0">${esc(t('applicationSubmitted', { date: formatDateTime(a.createdAt) }))}</p>
          </div>
          <div class="application-actions">
            <button type="button" class="btn btn-sm btn-primary" data-approve="${esc(a.id)}">${esc(t('approve'))}</button>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-reject="${esc(a.id)}">${esc(t('reject'))}</button>
          </div>
        </article>`,
          )
          .join('')
      : `<p class="text-muted small mb-0">${esc(t('applicationsEmpty'))}</p>`;
  };

  const loadApplications = async () => {
    try {
      applications = (await api('GET', '/api/v1/merchant-applications?status=PENDING')).applications;
      renderApplications();
    } catch (error) {
      showMessage(errorText(error), 'error', 'application-message');
    }
  };

  /** @param {Application} a */
  const approve = (a) => {
    const dialog = openDialog(`
      <form id="approve-form" novalidate>
        <h2 class="h5 mb-2 pe-4">${esc(t('approveTitle', { name: a.name }))}</h2>
        <p class="small mb-3">${esc(t('approveIntro', { email: a.admin.email }))}</p>
        <div class="mb-3">
          <label for="ap-name" class="form-label small">${esc(t('merchantName'))}</label>
          <input id="ap-name" name="name" class="form-control" maxlength="120" value="${esc(a.name)}" required />
        </div>
        <div class="mb-3">
          <label for="ap-slug" class="form-label small">${esc(t('merchantSlug'))}</label>
          <input id="ap-slug" name="slug" class="form-control" maxlength="48" value="${esc(a.slug)}" autocapitalize="off" spellcheck="false" required />
          <div class="form-text">${esc(t('merchantSlugHint'))}</div>
        </div>
        ${messageSlot('approve-message')}
        <div class="d-flex gap-2 mt-3">
          <button type="button" class="btn btn-outline-secondary flex-fill" data-close>${esc(t('cancel'))}</button>
          <button type="submit" class="btn btn-primary flex-fill">${esc(t('approve'))}</button>
        </div>
      </form>`);
    const form = /** @type {HTMLFormElement} */ (dialog.querySelector('form'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      busy(form, async () => {
        const values = formValues(form);
        try {
          const result = await api('POST', `/api/v1/merchant-applications/${encodeURIComponent(a.id)}/approve`, {
            name: values.name.trim(),
            slug: values.slug.trim(),
          });
          showCredentials(dialog, {
            title: t('approvedTitle', { name: result.merchant.name }),
            intro: t('approvedIntro', { name: a.admin.displayName }),
            email: result.admin.email,
            temporaryPassword: result.temporaryPassword,
            expiresAt: result.expiresAt,
          });
          showMessage(t('merchantCreated', { name: result.merchant.name }), 'success', 'application-message');
          await Promise.all([loadApplications(), load()]);
        } catch (error) {
          showMessage(errorText(error), 'error', 'approve-message');
        }
      });
    });
    /** @type {HTMLInputElement} */ (form.querySelector('#ap-name')).focus();
  };

  /** @param {Application} a */
  const reject = (a) => {
    const dialog = openDialog(`
      <form id="reject-form" novalidate>
        <h2 class="h5 mb-2 pe-4">${esc(t('rejectTitle', { name: a.name }))}</h2>
        <label for="rj-reason" class="form-label small">${esc(t('rejectReason'))}</label>
        <textarea id="rj-reason" name="reason" class="form-control" rows="3" maxlength="500" required></textarea>
        <div class="form-text">${esc(t('rejectHint'))}</div>
        ${messageSlot('reject-message')}
        <div class="d-flex gap-2 mt-3">
          <button type="button" class="btn btn-outline-secondary flex-fill" data-close>${esc(t('cancel'))}</button>
          <button type="submit" class="btn btn-danger flex-fill">${esc(t('reject'))}</button>
        </div>
      </form>`);
    const form = /** @type {HTMLFormElement} */ (dialog.querySelector('form'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const reason = formValues(form).reason.trim();
      if (!reason) {
        showMessage(t('rejectReasonRequired'), 'error', 'reject-message');
        return;
      }
      busy(form, async () => {
        try {
          const result = await api('POST', `/api/v1/merchant-applications/${encodeURIComponent(a.id)}/reject`, { reason });
          dialog.close();
          showMessage(t('applicationRejected', { name: a.name, reason: result.application.rejectReason }), 'success', 'application-message');
          await loadApplications();
        } catch (error) {
          showMessage(errorText(error), 'error', 'reject-message');
        }
      });
    });
    /** @type {HTMLTextAreaElement} */ (form.querySelector('textarea')).focus();
  };

  $('#application-list').addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('button');
    const a = applications.find((item) => item.id === (button?.getAttribute('data-approve') ?? button?.getAttribute('data-reject')));
    if (!button || !a) return;
    if (button.hasAttribute('data-approve')) approve(a);
    else reject(a);
  });

  /** @param {string} userId @param {string} email */
  const reissue = async (userId, email) => {
    if (!confirm(t('newTemporaryPasswordConfirm', { email }))) return;
    try {
      const result = await api('POST', `/api/v1/users/${encodeURIComponent(userId)}/temporary-password`);
      const dialog = openDialog('');
      showCredentials(dialog, {
        title: t('newTemporaryPasswordTitle'),
        intro: t('newTemporaryPasswordIntro'),
        email: result.admin.email,
        temporaryPassword: result.temporaryPassword,
        expiresAt: result.expiresAt,
      });
      await load();
    } catch (error) {
      showMessage(errorText(error), 'error', 'merchant-message');
    }
  };

  const renderRows = () => {
    $('#merchant-rows').innerHTML = merchants.length
      ? merchants
          .map(
            (m) => `
        <tr>
          <td class="merchant-cell">
            ${m.brand?.logoUrl ? `<img class="merchant-logo" src="${esc(m.brand.logoUrl)}" alt="" />` : ''}
            <span class="d-block fw-semibold">${esc(m.name)}</span>
            <span class="d-block small text-muted text-break">${esc([m.contactPhone, m.contactEmail].filter(Boolean).join(' · ') || m.slug)}</span>
            ${m.awaitingFirstSignIn
              .map(
                (admin) => `
            <span class="awaiting d-block small mt-1 text-break">
              ${esc(t('awaitingFirstSignIn', { email: admin.email, date: admin.expiresAt ? formatDateTime(admin.expiresAt) : '–' }))}
              <button type="button" class="btn btn-link btn-sm p-0 align-baseline" data-temp="${esc(admin.userId)}" data-email="${esc(admin.email)}">${esc(t('newTemporaryPassword'))}</button>
            </span>`,
              )
              .join('')}
          </td>
          <td data-label="${esc(t('merchantPeople'))}">${esc(t('merchantAdminsCount', { admins: m.admins, members: m.members }))}</td>
          <td data-label="${esc(t('status'))}"><span class="pill pill-${esc(m.status.toLowerCase())}">${esc(t(`status_${m.status}`))}</span></td>
          <td data-label="${esc(t('createdAt'))}" class="text-nowrap">${esc(formatDate(m.createdAt))}</td>
          <td class="text-md-end">
            <div class="d-flex flex-wrap gap-2 justify-content-md-end">
              ${m.status === 'ACTIVE' ? `<button type="button" class="btn btn-sm btn-outline-secondary" data-invite="${esc(m.id)}">${esc(t('inviteAdmin'))}</button>` : ''}
              <button type="button" class="btn btn-sm btn-outline-secondary" data-logo="${esc(m.id)}">${esc(t(m.brand?.logoUrl ? 'brandReplaceLogo' : 'brandPickLogo'))}</button>
              <button type="button" class="btn btn-sm btn-outline-secondary" data-status="${m.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'}" data-id="${esc(m.id)}">
                ${esc(t(m.status === 'ACTIVE' ? 'pause' : 'resume'))}
              </button>
            </div>
          </td>
        </tr>`,
          )
          .join('')
      : `<tr><td colspan="5" class="text-muted">${esc(t('noMerchants'))}</td></tr>`;

    const select = /** @type {HTMLSelectElement} */ ($('#i-merchant'));
    const selected = select.value;
    select.innerHTML = merchants
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)}</option>`)
      .join('');
  };

  const load = async () => {
    try {
      merchants = (await api('GET', '/api/v1/merchants')).merchants;
      renderRows();
    } catch (error) {
      showMessage(errorText(error), 'error', 'merchant-message');
    }
  };

  const createForm = /** @type {HTMLFormElement} */ ($('#merchant-create'));
  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(createForm, async () => {
      showMessage('', 'info', 'merchant-message');
      $('#merchant-link').hidden = true;
      const values = formValues(createForm);
      const withAdmin = Boolean(values.adminEmail.trim() || values.adminName.trim());
      try {
        const result = await api('POST', '/api/v1/merchants', {
          name: values.name,
          contactEmail: values.contactEmail,
          contactPhone: values.contactPhone,
          address: values.address,
          ...(withAdmin
            ? { admin: { email: values.adminEmail, displayName: values.adminName, preferredLanguage: values.preferredLanguage } }
            : {}),
        });
        const created = t('merchantCreated', { name: result.merchant.name });
        if (result.invitation) showInvitation(created, result.invitation, values.adminName, 'merchant-link', 'merchant-message');
        else showMessage(created, 'success', 'merchant-message');
        createForm.reset();
        await load();
      } catch (error) {
        showMessage(errorText(error), 'error', 'merchant-message');
      }
    });
  });

  const inviteForm = /** @type {HTMLFormElement} */ ($('#merchant-invite'));
  inviteForm.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(inviteForm, async () => {
      showMessage('', 'info', 'invite-message');
      const values = formValues(inviteForm);
      try {
        const result = await api('POST', '/api/v1/users/invitations', { ...values, role: 'TENANT_ADMIN' });
        showInvitation('', result, values.displayName, 'invite-link', 'invite-message');
        inviteForm.reset();
        await load();
      } catch (error) {
        showMessage(errorText(error), 'error', 'invite-message');
      }
    });
  });

  const logoInput = document.createElement('input');
  logoInput.type = 'file';
  logoInput.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif';
  let logoFor = '';
  logoInput.addEventListener('change', async () => {
    const picked = logoInput.files?.[0];
    logoInput.value = '';
    const merchant = merchants.find((m) => m.id === logoFor);
    if (!picked || !merchant) return;
    try {
      await api('POST', `/api/v1/merchants/${encodeURIComponent(merchant.id)}/logo`, await prepareLogo(picked));
      showMessage(t('brandLogoSavedFor', { name: merchant.name }), 'success', 'merchant-message');
      await load();
    } catch (error) {
      showMessage(errorText(error), 'error', 'merchant-message');
    }
  });

  $('#merchant-rows').addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target).closest('button');
    if (!target) return;
    const tempFor = target.getAttribute('data-temp');
    if (tempFor) {
      reissue(tempFor, target.getAttribute('data-email') ?? '');
      return;
    }
    const logoId = target.getAttribute('data-logo');
    if (logoId) {
      logoFor = logoId;
      logoInput.click();
      return;
    }
    const inviteId = target.getAttribute('data-invite');
    if (inviteId) {
      /** @type {HTMLSelectElement} */ ($('#i-merchant')).value = inviteId;
      $('#invite-admin').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#i-name').focus({ preventScroll: true });
      return;
    }
    const id = target.getAttribute('data-id');
    const status = target.getAttribute('data-status');
    const merchant = merchants.find((m) => m.id === id);
    if (!merchant || !status) return;
    if (status === 'PAUSED' && !confirm(t('pauseConfirm', { name: merchant.name }))) return;
    try {
      await api('POST', `/api/v1/merchants/${encodeURIComponent(merchant.id)}/status`, { status });
      await load();
    } catch (error) {
      showMessage(errorText(error), 'error', 'merchant-message');
    }
  });

  load();
  loadApplications();
}
