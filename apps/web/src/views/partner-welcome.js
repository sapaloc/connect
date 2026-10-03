import { api } from '../api.js';
import { $, busy, esc, formValues } from '../dom.js';
import { errorText, t } from '../i18n.js';
import { FIND_MERCHANTS_PATH } from '../nav.js';
import { authLayout, messageSlot, showMessage } from './common.js';

/** @typedef {import('../main.js').App} App */
/**
 * @typedef {{
 *   id: string, relationshipKind: 'COMPANY' | 'INDEPENDENT_INDIVIDUAL', partnerType: string, name: string,
 *   contactName: string | null, phone: string | null, email: string, preferredLanguage: 'en' | 'vi', note: string | null,
 * }} PartnerProfile
 */

/** @param {PartnerProfile} p */
function facts(p) {
  const rows = /** @type {Array<[string, string | null]>} */ ([
    [t('partnerType'), `${t(`ptype_${p.partnerType}`)} · ${t(`kind_${p.relationshipKind}`)}`],
    [t('contactName'), p.relationshipKind === 'COMPANY' ? p.contactName : null],
    [t('email'), p.email],
    [t('contactPhone'), p.phone],
    [t('language'), p.preferredLanguage.toUpperCase()],
    [t('partnerNote'), p.note],
  ]);
  return rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`)
    .join('');
}

/** @param {PartnerProfile} p */
function contactForm(p) {
  const company = p.relationshipKind === 'COMPANY';
  return `
    <form id="partner-contact" novalidate hidden>
      ${
        company
          ? `<div class="mb-3">
        <label for="pc-contact" class="form-label small">${esc(t('contactName'))}</label>
        <input id="pc-contact" name="contactName" class="form-control" maxlength="120" value="${esc(p.contactName)}" required />
      </div>`
          : ''
      }
      <div class="row g-3 mb-3">
        <div class="col-8">
          <label for="pc-phone" class="form-label small">${esc(t('contactPhone'))}</label>
          <input id="pc-phone" name="phone" type="tel" class="form-control" maxlength="32" value="${esc(p.phone)}" />
        </div>
        <div class="col-4">
          <label for="pc-lang" class="form-label small">${esc(t('language'))}</label>
          <select id="pc-lang" name="preferredLanguage" class="form-select">
            <option value="en"${p.preferredLanguage === 'en' ? ' selected' : ''}>EN</option>
            <option value="vi"${p.preferredLanguage === 'vi' ? ' selected' : ''}>VI</option>
          </select>
        </div>
      </div>
      <div class="mb-3">
        <label for="pc-note" class="form-label small">${esc(t('partnerNote'))}</label>
        <textarea id="pc-note" name="note" class="form-control" rows="2" maxlength="500">${esc(p.note)}</textarea>
      </div>
      <div class="d-flex gap-2">
        <button type="button" class="btn btn-outline-secondary flex-fill" data-cancel-contact>${esc(t('cancel'))}</button>
        <button type="submit" class="btn btn-primary flex-fill">${esc(t('partnerSaveContact'))}</button>
      </div>
    </form>`;
}

/**
 * First page of an approved partner who has joined no merchant yet: profile, contact edit and the
 * way to Find merchants.
 * @param {App} app
 */
export function partnerWelcomeView(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  app.root.innerHTML = authLayout({
    title: t('partnerWelcomeTitle', { name: profile.user.displayName }),
    subtitle: t('partnerWelcomeSubtitle'),
    body: `
      <section class="partner-card" aria-labelledby="profile-title">
        <h2 class="h6 mb-1" id="profile-title">${esc(t('partnerProfileTitle'))}</h2>
        <div id="partner-profile"><p class="text-muted small mb-0">…</p></div>
        ${messageSlot('profile-message')}
      </section>
      <section class="partner-card" aria-labelledby="find-title">
        <h2 class="h6 mb-2" id="find-title">${esc(t('findMerchantsTitle'))}</h2>
        <p class="small text-muted mb-3">${esc(t('findMerchantsBody'))}</p>
        <a href="${FIND_MERCHANTS_PATH}" data-nav class="btn btn-primary w-100">${esc(t('findMerchantsButton'))}</a>
      </section>
      <p class="text-center small mb-0"><a href="#" data-signout>${esc(t('signOut'))}</a></p>`,
  });
  document.title = `${t('partnerWelcomeDocTitle')} · MyConnect`;

  /** @param {PartnerProfile} p */
  const render = (p) => {
    const box = $('#partner-profile');
    box.innerHTML = `
      <p class="fw-semibold mb-2">${esc(p.name)}</p>
      <dl class="profile-facts">${facts(p)}</dl>
      <button type="button" class="btn btn-outline-secondary w-100" data-edit-contact>${esc(t('partnerEditContact'))}</button>
      ${contactForm(p)}`;
    const form = /** @type {HTMLFormElement} */ ($('#partner-contact', box));
    const edit = /** @type {HTMLButtonElement} */ ($('[data-edit-contact]', box));
    const toggle = (/** @type {boolean} */ open) => {
      form.hidden = !open;
      edit.hidden = open;
      /** @type {HTMLElement} */ ($('.profile-facts', box)).hidden = open;
      if (open) /** @type {HTMLElement} */ (form.querySelector('input, select')).focus();
      else edit.focus();
    };
    edit.addEventListener('click', () => {
      showMessage('', 'info', 'profile-message');
      toggle(true);
    });
    $('[data-cancel-contact]', form).addEventListener('click', () => toggle(false));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = formValues(form);
      if (p.relationshipKind === 'COMPANY' && !values.contactName?.trim()) {
        showMessage(t('partnerContactRequired'), 'error', 'profile-message');
        return;
      }
      busy(form, async () => {
        try {
          const result = await api('POST', '/api/v1/partner-profile', values);
          render(result.profile);
          showMessage(t('partnerProfileSaved'), 'success', 'profile-message');
        } catch (error) {
          showMessage(errorText(error), 'error', 'profile-message');
        }
      });
    });
  };

  api('GET', '/api/v1/partner-profile')
    .then((result) => render(result.profile))
    .catch((error) => showMessage(errorText(error), 'error', 'profile-message'));
}
