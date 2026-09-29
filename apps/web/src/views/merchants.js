import { api } from '../api.js';
import { $, busy, esc, formValues } from '../dom.js';
import { errorText, formatDateTime, getLang, t } from '../i18n.js';
import { messageSlot, showLink, showMessage } from './common.js';

/** @typedef {import('../main.js').App} App */
/**
 * @typedef {{
 *   id: string, name: string, slug: string | null, status: 'ACTIVE' | 'PAUSED',
 *   contactEmail: string | null, contactPhone: string | null, address: string | null,
 *   createdAt: string, admins: number, members: number,
 * }} Merchant
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

/** @param {App} _app */
export function mountMerchants(_app) {
  /** @type {Merchant[]} */
  let merchants = [];

  const renderRows = () => {
    $('#merchant-rows').innerHTML = merchants.length
      ? merchants
          .map(
            (m) => `
        <tr>
          <td>
            <span class="d-block fw-semibold">${esc(m.name)}</span>
            <span class="d-block small text-muted text-break">${esc([m.contactPhone, m.contactEmail].filter(Boolean).join(' · ') || m.slug)}</span>
          </td>
          <td data-label="${esc(t('merchantPeople'))}">${esc(t('merchantAdminsCount', { admins: m.admins, members: m.members }))}</td>
          <td data-label="${esc(t('status'))}"><span class="pill pill-${esc(m.status.toLowerCase())}">${esc(t(`status_${m.status}`))}</span></td>
          <td data-label="${esc(t('createdAt'))}">${esc(formatDateTime(m.createdAt))}</td>
          <td class="text-md-end">
            <div class="d-flex flex-wrap gap-2 justify-content-md-end">
              ${m.status === 'ACTIVE' ? `<button type="button" class="btn btn-sm btn-outline-secondary" data-invite="${esc(m.id)}">${esc(t('inviteAdmin'))}</button>` : ''}
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

  $('#merchant-rows').addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target).closest('button');
    if (!target) return;
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
}
