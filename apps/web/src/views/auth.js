import { PARTNER_TYPES } from '#domain';
import { api } from '../api.js';
import { $, busy, esc, formValues } from '../dom.js';
import { errorText, getLang, t } from '../i18n.js';
import {
  authLayout,
  bindPasswordPolicy,
  messageSlot,
  passwordFields,
  passwordInput,
  passwordProblem,
  showMessage,
} from './common.js';
import { switchLabel } from './shell.js';

/** @typedef {import('../main.js').App} App */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ['COMPANY', 'INDEPENDENT_INDIVIDUAL'];

/** @typedef {'merchant' | 'partner'} RegisterType */

/** Kept across re-renders (language switch) while the app stays open. @type {RegisterType} */
let registerType = 'merchant';

/** @param {RegisterType} type */
const registerPath = (type) => (type === 'partner' ? '/register?type=partner' : '/register');

/** @param {import('../api.js').Profile} profile */
function afterSignIn(profile) {
  if (profile.mustChangePassword) return '/change-password';
  return profile.landing ?? '/select-role';
}

/** @param {string} label */
const optionalLabel = (label) => `${esc(label)} <span class="text-muted">(${esc(t('optional'))})</span>`;

/** @param {App} app */
function signInPane(app) {
  return `
    <h1 class="h4 mb-1">${esc(t('signInTitle'))}</h1>
    <p class="text-muted mb-4">${esc(t('signInSubtitle'))}</p>
    <form id="sign-in" novalidate>
      <div class="mb-3">
        <label for="email" class="form-label">${esc(t('email'))}</label>
        <input id="email" name="email" type="email" class="form-control form-control-lg"
          autocomplete="username" value="${esc(app.state.prefillEmail)}" required />
      </div>
      <div class="mb-4">
        <label for="password" class="form-label">${esc(t('password'))}</label>
        ${passwordInput({ id: 'password', autocomplete: 'current-password' })}
      </div>
      <button type="submit" class="btn btn-primary btn-lg w-100">${esc(t('signIn'))}</button>
      ${messageSlot()}
      <p class="text-center small mt-3 mb-0"><a href="/forgot" data-nav>${esc(t('forgotLink'))}</a></p>
    </form>`;
}

function merchantForm() {
  const lang = getLang();
  return `
    <h2 class="h4 mb-1">${esc(t('registerTitle'))}</h2>
    <p class="text-muted mb-4">${esc(t('registerSubtitle'))}</p>
    <form id="register" novalidate>
      <div class="mb-3">
        <label for="r-name" class="form-label">${esc(t('registerBusinessName'))}</label>
        <input id="r-name" name="name" class="form-control" maxlength="120" autocomplete="organization" required />
      </div>
      <div class="row g-3 mb-3">
        <div class="col-12 col-sm-6 col-md-12 col-lg-6">
          <label for="r-phone" class="form-label">${optionalLabel(t('contactPhone'))}</label>
          <input id="r-phone" name="contactPhone" type="tel" class="form-control" maxlength="32" autocomplete="tel" />
        </div>
        <div class="col-12 col-sm-6 col-md-12 col-lg-6">
          <label for="r-contact-email" class="form-label">${optionalLabel(t('contactEmail'))}</label>
          <input id="r-contact-email" name="contactEmail" type="email" class="form-control" maxlength="254" />
        </div>
      </div>
      <div class="mb-3">
        <label for="r-address" class="form-label">${optionalLabel(t('address'))}</label>
        <input id="r-address" name="address" class="form-control" maxlength="300" autocomplete="street-address" />
      </div>
      <fieldset class="mb-3">
        <legend class="form-label fw-semibold fs-6 mb-1">${esc(t('registerAdminTitle'))}</legend>
        <p class="small text-muted mb-2">${esc(t('registerAdminHint'))}</p>
        <div class="mb-3">
          <label for="r-admin-name" class="form-label">${esc(t('registerAdminName'))}</label>
          <input id="r-admin-name" name="adminName" class="form-control" maxlength="120" autocomplete="name" required />
        </div>
        <div class="row g-3">
          <div class="col-8">
            <label for="r-admin-email" class="form-label">${esc(t('email'))}</label>
            <input id="r-admin-email" name="adminEmail" type="email" class="form-control" maxlength="254" autocomplete="email" required />
          </div>
          <div class="col-4">
            <label for="r-admin-lang" class="form-label">${esc(t('language'))}</label>
            <select id="r-admin-lang" name="adminLanguage" class="form-select" required>
              <option value="en"${lang === 'en' ? ' selected' : ''}>EN</option>
              <option value="vi"${lang === 'vi' ? ' selected' : ''}>VI</option>
            </select>
          </div>
        </div>
      </fieldset>
      <div class="hp-field" aria-hidden="true">
        <label for="r-website">Website</label>
        <input id="r-website" name="website" tabindex="-1" autocomplete="off" />
      </div>
      <div class="form-check mb-4">
        <input id="r-terms" name="acceptTerms" type="checkbox" class="form-check-input" required />
        <label for="r-terms" class="form-check-label small">${esc(t('registerTerms'))}</label>
      </div>
      <button type="submit" class="btn btn-primary btn-lg w-100">${esc(t('registerSubmit'))}</button>
      ${messageSlot('register-message')}
    </form>`;
}

/** @param {string} prefix */
function languageSelect(prefix) {
  const lang = getLang();
  return `
    <select id="${prefix}-lang" name="preferredLanguage" class="form-select" required>
      <option value="en"${lang === 'en' ? ' selected' : ''}>EN</option>
      <option value="vi"${lang === 'vi' ? ' selected' : ''}>VI</option>
    </select>`;
}

function partnerForm() {
  return `
    <h2 class="h4 mb-1">${esc(t('partnerRegisterTitle'))}</h2>
    <p class="text-muted mb-4">${esc(t('partnerRegisterSubtitle'))}</p>
    <form id="partner-register" novalidate>
      <fieldset class="mb-3">
        <legend class="form-label fs-6 mb-2">${esc(t('partnerKindLegend'))}</legend>
        <div class="btn-group w-100" role="radiogroup" aria-label="${esc(t('partnerKindLegend'))}">
          ${KINDS.map(
            (kind, index) => `
            <input type="radio" class="btn-check" name="relationshipKind" id="pr-kind-${kind}" value="${kind}"${index === 0 ? ' checked' : ''} />
            <label class="btn btn-outline-secondary" for="pr-kind-${kind}">${esc(t(`kind_${kind}`))}</label>`,
          ).join('')}
        </div>
      </fieldset>
      <div class="mb-3">
        <label for="pr-type" class="form-label">${esc(t('partnerType'))}</label>
        <select id="pr-type" name="partnerType" class="form-select">
          ${PARTNER_TYPES.map((type) => `<option value="${type}">${esc(t(`ptype_${type}`))}</option>`).join('')}
        </select>
      </div>
      <div class="mb-3">
        <label for="pr-name" class="form-label" data-name-label>${esc(t('registerBusinessName'))}</label>
        <input id="pr-name" name="name" class="form-control" maxlength="120" autocomplete="organization" required />
      </div>
      <div class="mb-3" data-contact>
        <label for="pr-contact" class="form-label">${esc(t('contactName'))}</label>
        <input id="pr-contact" name="contactName" class="form-control" maxlength="120" autocomplete="name" />
      </div>
      <div class="mb-3">
        <label for="pr-phone" class="form-label">${optionalLabel(t('contactPhone'))}</label>
        <input id="pr-phone" name="phone" type="tel" class="form-control" maxlength="32" autocomplete="tel" />
      </div>
      <div class="row g-3 mb-3">
        <div class="col-8">
          <label for="pr-email" class="form-label">${esc(t('email'))}</label>
          <input id="pr-email" name="email" type="email" class="form-control" maxlength="254" autocomplete="email" required />
        </div>
        <div class="col-4">
          <label for="pr-lang" class="form-label">${esc(t('language'))}</label>
          ${languageSelect('pr')}
        </div>
      </div>
      <div class="mb-3">
        <label for="pr-note" class="form-label">${optionalLabel(t('partnerNote'))}</label>
        <textarea id="pr-note" name="note" class="form-control" rows="2" maxlength="500" aria-describedby="pr-note-hint"></textarea>
        <div class="form-text" id="pr-note-hint">${esc(t('partnerNoteHint'))}</div>
      </div>
      <div class="hp-field" aria-hidden="true">
        <label for="pr-website">Website</label>
        <input id="pr-website" name="website" tabindex="-1" autocomplete="off" />
      </div>
      <div class="form-check mb-4">
        <input id="pr-terms" name="acceptTerms" type="checkbox" class="form-check-input" required />
        <label for="pr-terms" class="form-check-label small">${esc(t('registerTerms'))}</label>
      </div>
      <button type="submit" class="btn btn-primary btn-lg w-100">${esc(t('registerSubmit'))}</button>
      ${messageSlot('partner-register-message')}
    </form>`;
}

/** Merchant | Partner switch above the two forms; only the chosen one shows. */
function registerPane() {
  return `
    <div class="register-type" role="radiogroup" aria-label="${esc(t('registerAs'))}">
      ${/** @type {RegisterType[]} */ (['merchant', 'partner'])
        .map(
          (type) => `
        <input type="radio" class="btn-check" name="registerType" id="register-type-${type}" value="${type}"${type === registerType ? ' checked' : ''} />
        <label for="register-type-${type}">${esc(t(type === 'partner' ? 'registerTypePartner' : 'registerTypeMerchant'))}</label>`,
        )
        .join('')}
    </div>
    <div class="register-form" data-register="merchant">${merchantForm()}</div>
    <div class="register-form" data-register="partner">${partnerForm()}</div>`;
}

/**
 * First problem of the register form as [field id, message], or null.
 * @param {Record<string, string>} values
 * @returns {[string, string] | null}
 */
function registerProblem(values) {
  if (!values.name.trim()) return ['r-name', t('registerNameRequired')];
  if (values.contactEmail.trim() && !EMAIL_PATTERN.test(values.contactEmail.trim())) return ['r-contact-email', t('registerEmailInvalid')];
  if (!values.adminName.trim()) return ['r-admin-name', t('registerAdminNameRequired')];
  if (!EMAIL_PATTERN.test(values.adminEmail.trim())) return ['r-admin-email', t('registerEmailInvalid')];
  if (values.acceptTerms !== 'on') return ['r-terms', t('registerTermsRequired')];
  return null;
}

/**
 * First problem of the partner form as [field id, message], or null.
 * @param {Record<string, string>} values
 * @returns {[string, string] | null}
 */
function partnerProblem(values) {
  if (!values.name.trim()) return ['pr-name', t('partnerNameRequired')];
  if (values.relationshipKind === 'COMPANY' && !values.contactName.trim()) return ['pr-contact', t('partnerContactRequired')];
  if (!EMAIL_PATTERN.test(values.email.trim())) return ['pr-email', t('registerEmailInvalid')];
  if (values.acceptTerms !== 'on') return ['pr-terms', t('registerTermsRequired')];
  return null;
}

/**
 * "We received your application" in place of the Register column.
 * @param {(tab: 'signin' | 'register', options?: { focus?: boolean }) => void} select
 * @param {string} body
 * @param {string} email
 */
function showRegisterDone(select, body, email) {
  const pane = $('#pane-register');
  pane.innerHTML = `
    <div class="register-done" tabindex="-1">
      <h2 class="h4 mb-2">${esc(t('registerDoneTitle'))}</h2>
      <p class="mb-2">${esc(body)}</p>
      <p class="text-muted small mb-4">${esc(t('registerDoneNext', { email: email.trim().toLowerCase() }))}</p>
      <button type="button" class="btn btn-outline-secondary w-100" data-goto-signin>${esc(t('backToSignIn'))}</button>
    </div>`;
  /** @type {HTMLElement} */ ($('.register-done', pane)).focus();
  $('[data-goto-signin]', pane).addEventListener('click', () => select('signin', { focus: true }));
}

/**
 * Sign in and Register side by side from 768 px; tabs below that. `/register` opens the Register tab,
 * `/register?type=partner` its Partner form. On `/login` the Merchant | Partner switch keeps the address.
 * @param {App} app
 * @param {'signin' | 'register'} initial
 */
function accessView(app, initial) {
  if (initial === 'register') registerType = new URLSearchParams(location.search).get('type') === 'partner' ? 'partner' : 'merchant';
  app.root.innerHTML = authLayout({
    wide: true,
    back: { href: '/', label: t('backHome') },
    body: `
      <div class="auth-tabs" role="tablist" aria-label="${esc(t('signInOrRegister'))}">
        <button type="button" role="tab" id="tab-signin" aria-controls="pane-signin" data-tab="signin">${esc(t('signIn'))}</button>
        <button type="button" role="tab" id="tab-register" aria-controls="pane-register" data-tab="register">${esc(t('registerTab'))}</button>
      </div>
      <div class="auth-panes">
        <section class="auth-pane" id="pane-signin" role="tabpanel" aria-labelledby="tab-signin">${signInPane(app)}</section>
        <section class="auth-pane" id="pane-register" role="tabpanel" aria-labelledby="tab-register">${registerPane()}</section>
      </div>`,
  });
  app.consumeFlash();

  const panes = /** @type {HTMLElement} */ ($('.auth-panes'));
  const tabs = /** @type {HTMLButtonElement[]} */ ([...app.root.querySelectorAll('[role="tab"]')]);
  /** @param {'signin' | 'register'} tab @param {{ focus?: boolean }} [options] */
  const select = (tab, { focus = false } = {}) => {
    panes.dataset.tab = tab;
    for (const button of tabs) {
      const active = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    }
    const path = tab === 'signin' ? '/login' : registerPath(registerType);
    if (location.pathname + location.search !== path) history.replaceState(null, '', path);
  };
  select(initial);

  const registerPaneEl = /** @type {HTMLElement} */ ($('#pane-register'));
  /** @param {RegisterType} type */
  const showType = (type) => {
    registerType = type;
    registerPaneEl.dataset.type = type;
    if (location.pathname === '/register') history.replaceState(null, '', registerPath(type));
  };
  showType(registerType);
  registerPaneEl.querySelectorAll('input[name="registerType"]').forEach((radio) => {
    radio.addEventListener('change', () => showType(/** @type {RegisterType} */ (/** @type {HTMLInputElement} */ (radio).value)));
  });
  for (const button of tabs) {
    button.addEventListener('click', () => select(/** @type {'signin' | 'register'} */ (button.dataset.tab)));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      select(button.dataset.tab === 'signin' ? 'register' : 'signin', { focus: true });
    });
  }

  const form = /** @type {HTMLFormElement} */ ($('#sign-in'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(form, async () => {
      const { email, password } = formValues(form);
      try {
        const profile = await api('POST', '/api/v1/auth/login', { email, password });
        app.state.prefillEmail = '';
        app.setProfile(profile);
        app.navigate(afterSignIn(profile), { replace: true });
      } catch (error) {
        showMessage(errorText(error));
        /** @type {HTMLInputElement} */ ($('#password')).value = '';
      }
    });
  });

  const register = /** @type {HTMLFormElement} */ ($('#register'));
  register.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(register);
    register.querySelectorAll('[aria-invalid]').forEach((field) => field.removeAttribute('aria-invalid'));
    const problem = registerProblem(values);
    if (problem) {
      const field = $(`#${problem[0]}`);
      field.setAttribute('aria-invalid', 'true');
      field.focus();
      showMessage(problem[1], 'error', 'register-message');
      return;
    }
    busy(register, async () => {
      try {
        await api('POST', '/api/v1/merchant-applications', {
          name: values.name,
          contactPhone: values.contactPhone,
          contactEmail: values.contactEmail,
          address: values.address,
          admin: { displayName: values.adminName, email: values.adminEmail, preferredLanguage: values.adminLanguage },
          acceptTerms: true,
          website: values.website ?? '',
        });
        showRegisterDone(select, t('registerDoneBody', { name: values.name.trim() }), values.adminEmail);
      } catch (error) {
        showMessage(errorText(error), 'error', 'register-message');
      }
    });
  });

  const partner = /** @type {HTMLFormElement} */ ($('#partner-register'));
  const syncKind = () => {
    const company = formValues(partner).relationshipKind !== 'INDEPENDENT_INDIVIDUAL';
    $('[data-name-label]', partner).textContent = t(company ? 'registerBusinessName' : 'registerAdminName');
    /** @type {HTMLInputElement} */ ($('#pr-name', partner)).autocomplete = company ? 'organization' : 'name';
    /** @type {HTMLElement} */ ($('[data-contact]', partner)).hidden = !company;
  };
  syncKind();
  partner.querySelectorAll('input[name="relationshipKind"]').forEach((radio) => radio.addEventListener('change', syncKind));
  partner.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(partner);
    partner.querySelectorAll('[aria-invalid]').forEach((field) => field.removeAttribute('aria-invalid'));
    const problem = partnerProblem(values);
    if (problem) {
      const field = $(`#${problem[0]}`);
      field.setAttribute('aria-invalid', 'true');
      field.focus();
      showMessage(problem[1], 'error', 'partner-register-message');
      return;
    }
    const company = values.relationshipKind === 'COMPANY';
    busy(partner, async () => {
      try {
        await api('POST', '/api/v1/partner-applications', {
          relationshipKind: values.relationshipKind,
          partnerType: values.partnerType,
          name: values.name,
          contactName: company ? values.contactName : '',
          phone: values.phone,
          email: values.email,
          preferredLanguage: values.preferredLanguage,
          note: values.note,
          acceptTerms: true,
          website: values.website ?? '',
        });
        showRegisterDone(select, t('partnerDoneBody', { name: values.name.trim() }), values.email);
      } catch (error) {
        showMessage(errorText(error), 'error', 'partner-register-message');
      }
    });
  });
}

/** @param {App} app */
export function loginView(app) {
  accessView(app, 'signin');
}

/** @param {App} app */
export function registerView(app) {
  accessView(app, 'register');
}

/**
 * Signed in with a temporary password: nothing else opens until it is replaced.
 * @param {App} app
 */
export function changePasswordView(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  app.root.innerHTML = authLayout({
    title: t('changePasswordTitle'),
    subtitle: t('changePasswordSubtitle'),
    body: `
      <form id="change-password" novalidate>
        <div class="invite-who mb-3">
          <div class="fw-semibold">${esc(profile.user.displayName)}</div>
          <div class="small text-muted">${esc(profile.user.email)}</div>
        </div>
        <div class="mb-3">
          <label for="current" class="form-label">${esc(t('temporaryPassword'))}</label>
          ${passwordInput({ id: 'current', autocomplete: 'current-password' })}
        </div>
        ${passwordFields()}
        <button type="submit" class="btn btn-primary btn-lg w-100">${esc(t('changePasswordSubmit'))}</button>
        ${messageSlot()}
        <p class="text-center small mt-3 mb-0"><a href="#" data-signout>${esc(t('signOut'))}</a></p>
      </form>`,
  });
  document.title = `${t('changePasswordTitle')} · MyConnect`;

  const form = /** @type {HTMLFormElement} */ ($('#change-password'));
  bindPasswordPolicy(form);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(form);
    const problem = values.current ? passwordProblem(values) : t('temporaryPasswordRequired');
    if (problem) {
      showMessage(problem);
      return;
    }
    busy(form, async () => {
      try {
        const next = await api('POST', '/api/v1/auth/password/change', { currentPassword: values.current, newPassword: values.password });
        app.setProfile(next);
        app.navigate(afterSignIn(next), { replace: true });
      } catch (error) {
        showMessage(errorText(error));
      }
    });
  });
}

/** @param {App} app */
export function selectRoleView(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  const merchants = switchLabel(profile) === 'switchMerchant';
  app.root.innerHTML = authLayout({
    title: t(merchants ? 'chooseMerchantTitle' : 'chooseRoleTitle'),
    subtitle: t(merchants ? 'chooseMerchantSubtitle' : 'chooseRoleSubtitle'),
    body: `
      <div class="d-grid gap-2">
        ${profile.roles
          .map(
            (option) => `
          <button type="button" class="btn btn-outline-secondary btn-lg text-start role-option${
            option.roleAssignmentId === profile.activeRole?.roleAssignmentId ? ' active' : ''
          }" data-role="${esc(option.roleAssignmentId)}">
            <span class="d-block fw-semibold">${esc(option.tenantName ?? t(`role_${option.role}`))}</span>
            ${option.tenantName ? `<span class="d-block small">${esc(t(`role_${option.role}`))}</span>` : ''}
          </button>`,
          )
          .join('')}
      </div>
      ${messageSlot()}
      <p class="text-center small mt-3 mb-0"><a href="#" data-signout>${esc(t('signOut'))}</a></p>`,
  });

  app.root.querySelectorAll('[data-role]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const next = await api('POST', '/api/v1/auth/select-role', {
          roleAssignmentId: button.getAttribute('data-role'),
        });
        app.setProfile(next);
        app.navigate(next.landing, { replace: true });
      } catch (error) {
        showMessage(errorText(error));
      }
    });
  });
}

/** @param {App} app */
export function forgotView(app) {
  app.root.innerHTML = authLayout({
    title: t('forgotTitle'),
    subtitle: t('forgotSubtitle'),
    back: { href: '/login', label: t('backToSignIn') },
    body: `
      <form id="forgot" novalidate>
        <div class="mb-4">
          <label for="email" class="form-label">${esc(t('email'))}</label>
          <input id="email" name="email" type="email" class="form-control form-control-lg" autocomplete="username" required />
        </div>
        <button type="submit" class="btn btn-primary btn-lg w-100">${esc(t('forgotSubmit'))}</button>
        ${messageSlot()}
      </form>`,
  });

  const form = /** @type {HTMLFormElement} */ ($('#forgot'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(form, async () => {
      try {
        await api('POST', '/api/v1/auth/password-reset', { email: formValues(form).email });
        showMessage(t('forgotDone'), 'success');
      } catch (error) {
        showMessage(errorText(error));
      }
    });
  });
}

/**
 * Invitation and reset links carry the token in the URL fragment; it is read once and
 * removed from the address bar.
 * @param {App} app
 */
function takeLinkToken(app) {
  const fromHash = location.hash.slice(1);
  if (fromHash) {
    app.state.linkToken = fromHash;
    history.replaceState(null, '', location.pathname);
  }
  return app.state.linkToken;
}

/**
 * @param {App} app
 * @param {{ title: string, subtitle: string, submit: string, intro?: string }} text
 * @param {(values: Record<string, string>, token: string) => Promise<void>} onSubmit
 */
function passwordLinkForm(app, text, onSubmit) {
  const token = takeLinkToken(app);
  app.root.innerHTML = authLayout({
    title: text.title,
    subtitle: text.subtitle,
    back: { href: '/login', label: t('backToSignIn') },
    body: token
      ? `
      <form id="password-link" novalidate>
        <div id="intro"></div>
        ${passwordFields()}
        <button type="submit" class="btn btn-primary btn-lg w-100">${esc(text.submit)}</button>
        ${messageSlot()}
      </form>`
      : `<p class="form-message" data-tone="error">${esc(t('linkMissing'))}</p>`,
  });
  if (!token) return null;

  const form = /** @type {HTMLFormElement} */ ($('#password-link'));
  bindPasswordPolicy(form);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(form);
    const problem = passwordProblem(values);
    if (problem) {
      showMessage(problem);
      return;
    }
    busy(form, async () => {
      try {
        await onSubmit(values, token);
      } catch (error) {
        showMessage(errorText(error));
      }
    });
  });
  return form;
}

/** @param {App} app */
export function inviteView(app) {
  const form = passwordLinkForm(
    app,
    { title: t('inviteTitle'), subtitle: t('inviteSubtitle'), submit: t('inviteSubmit') },
    async (values, token) => {
      const result = await api('POST', '/api/v1/auth/invitations/accept', { token, password: values.password });
      app.state.linkToken = '';
      app.state.prefillEmail = result.email;
      app.flash(t('inviteDone'), 'success');
      app.navigate('/login', { replace: true });
    },
  );
  if (!form) return;

  api('POST', '/api/v1/auth/invitations/inspect', { token: app.state.linkToken })
    .then((invitation) => {
      $('#intro').innerHTML = `
        <div class="invite-who mb-3">
          <div class="fw-semibold">${esc(invitation.displayName)}</div>
          <div class="small text-muted">${esc(invitation.email)}</div>
        </div>`;
    })
    .catch((error) => {
      form.innerHTML = `<p class="form-message" data-tone="error">${esc(errorText(error))}</p>`;
    });
}

/** @param {App} app */
export function resetView(app) {
  passwordLinkForm(
    app,
    { title: t('resetTitle'), subtitle: t('resetSubtitle'), submit: t('resetSubmit') },
    async (values, token) => {
      const result = await api('POST', '/api/v1/auth/password-reset/confirm', { token, password: values.password });
      app.state.linkToken = '';
      app.state.prefillEmail = result.email;
      app.setProfile(null);
      app.flash(t('resetDone'), 'success');
      app.navigate('/login', { replace: true });
    },
  );
}
