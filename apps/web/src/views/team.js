import { INVITABLE_ROLES } from '#domain';
import { api } from '../api.js';
import { $, busy, esc, formValues } from '../dom.js';
import { errorText, formatDateTime, getLang, t } from '../i18n.js';
import { messageSlot, showLink, showMessage } from './common.js';

/** @typedef {import('../main.js').App} App */
/** @typedef {{ id: string, email: string, displayName: string, status: string, roles: string[], invitationOpen: boolean }} TeamUser */

/** @param {import('../api.js').Profile} profile */
export function teamPanel(profile) {
  const roles = INVITABLE_ROLES[/** @type {keyof typeof INVITABLE_ROLES} */ (profile.activeRole?.role)] ?? [];
  return `
    <section class="card-sw">
      <h2 class="card-title">${esc(t('teamInviteTitle'))}</h2>
      <p class="text-muted small mb-3">${esc(t('teamSubtitle'))}</p>
      <form id="invite" class="row g-3 align-items-end" novalidate>
        <div class="col-12 col-md-6 col-xl-4">
          <label for="invite-email" class="form-label small">${esc(t('email'))}</label>
          <input id="invite-email" name="email" type="email" class="form-control" required />
        </div>
        <div class="col-12 col-md-6 col-xl-3">
          <label for="invite-name" class="form-label small">${esc(t('displayName'))}</label>
          <input id="invite-name" name="displayName" class="form-control" maxlength="120" required />
        </div>
        <div class="col-7 col-md-4 col-xl-2">
          <label for="invite-role" class="form-label small">${esc(t('role'))}</label>
          <select id="invite-role" name="role" class="form-select">
            ${roles.map((role) => `<option value="${role}">${esc(t(`role_${role}`))}</option>`).join('')}
          </select>
        </div>
        <div class="col-5 col-md-3 col-xl-1">
          <label for="invite-lang" class="form-label small">${esc(t('language'))}</label>
          <select id="invite-lang" name="preferredLanguage" class="form-select">
            <option value="en"${getLang() === 'en' ? ' selected' : ''}>EN</option>
            <option value="vi"${getLang() === 'vi' ? ' selected' : ''}>VI</option>
          </select>
        </div>
        <div class="col-12 col-md-5 col-xl-2 d-grid">
          <button type="submit" class="btn btn-primary">${esc(t('inviteSend'))}</button>
        </div>
      </form>
      ${messageSlot('team-message')}
      <div id="link-box" class="link-box" hidden></div>
    </section>
    <section class="card-sw">
      <h2 class="card-title">${esc(t('teamTitle'))}</h2>
      <div class="table-responsive">
        <table class="table tbl tbl-stack align-middle mb-0">
          <thead>
            <tr>
              <th>${esc(t('displayName'))}</th>
              <th>${esc(t('role'))}</th>
              <th>${esc(t('status'))}</th>
              <th class="text-end">${esc(t('actions'))}</th>
            </tr>
          </thead>
          <tbody id="team-rows"></tbody>
        </table>
      </div>
    </section>`;
}

/** @param {App} app */
export function mountTeam(app) {
  /** @type {TeamUser[]} */
  let users = [];

  const renderRows = () => {
    const body = $('#team-rows');
    if (!body) return;
    body.innerHTML = users.length
      ? users
          .map(
            (user) => `
        <tr>
          <td>
            <span class="d-block fw-semibold">${esc(user.displayName)}</span>
            <span class="d-block small text-muted text-break">${esc(user.email)}</span>
          </td>
          <td data-label="${esc(t('role'))}">${user.roles.map((role) => esc(t(`role_${role}`))).join(', ')}</td>
          <td data-label="${esc(t('status'))}"><span class="pill pill-${esc(user.status.toLowerCase())}">${esc(t(`status_${user.status}`))}</span></td>
          <td class="text-md-end">
            ${
              user.status === 'INVITED'
                ? `<button type="button" class="btn btn-sm btn-outline-secondary" data-resend="${esc(user.id)}">${esc(t('resendInvite'))}</button>`
                : user.status === 'ACTIVE'
                  ? `<button type="button" class="btn btn-sm btn-outline-secondary" data-reset="${esc(user.id)}">${esc(t('issueReset'))}</button>`
                  : ''
            }
          </td>
        </tr>`,
          )
          .join('')
      : `<tr><td colspan="4" class="text-muted">${esc(t('noUsers'))}</td></tr>`;
  };

  const load = async () => {
    try {
      users = (await api('GET', '/api/v1/users')).users;
      renderRows();
    } catch (error) {
      showMessage(errorText(error), 'error', 'team-message');
    }
  };

  /** @param {{ email: string, displayName: string, role: string, preferredLanguage?: string }} input */
  const invite = async (input) => {
    const result = await api('POST', '/api/v1/users/invitations', input);
    if (result.inviteUrl) {
      showLink(t('inviteLinkReady', { name: input.displayName, expires: formatDateTime(result.expiresAt) }), result.inviteUrl);
    } else {
      $('#link-box').hidden = true;
      showMessage(t('roleGranted'), 'success', 'team-message');
    }
    await load();
  };

  const form = /** @type {HTMLFormElement} */ ($('#invite'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(form, async () => {
      showMessage('', 'info', 'team-message');
      try {
        const values = formValues(form);
        await invite({
          email: values.email,
          displayName: values.displayName,
          role: values.role,
          preferredLanguage: values.preferredLanguage,
        });
        form.reset();
      } catch (error) {
        showMessage(errorText(error), 'error', 'team-message');
      }
    });
  });

  $('#team-rows').addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const resendId = target.getAttribute('data-resend');
    const resetId = target.getAttribute('data-reset');
    const user = users.find((item) => item.id === (resendId ?? resetId));
    if (!user) return;
    showMessage('', 'info', 'team-message');
    try {
      if (resendId) {
        await invite({ email: user.email, displayName: user.displayName, role: user.roles[0] });
      } else {
        const result = await api('POST', `/api/v1/users/${encodeURIComponent(user.id)}/password-reset`);
        showLink(t('resetLinkReady', { name: user.displayName, expires: formatDateTime(result.expiresAt) }), result.resetUrl);
      }
    } catch (error) {
      showMessage(errorText(error), 'error', 'team-message');
    }
  });

  load();
}
