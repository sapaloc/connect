import { api } from '../api.js';
import { $, busy, esc, formValues } from '../dom.js';
import { errorText, t } from '../i18n.js';
import {
  authLayout,
  bindPasswordPolicy,
  messageSlot,
  passwordFields,
  passwordInput,
  passwordProblem,
  showMessage,
} from './common.js';

/** @typedef {import('../main.js').App} App */

/** @param {App} app */
export function loginView(app) {
  app.root.innerHTML = authLayout({
    title: t('signInTitle'),
    subtitle: t('signInSubtitle'),
    back: { href: '/', label: t('backHome') },
    body: `
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
      </form>`,
  });
  app.consumeFlash();

  const form = /** @type {HTMLFormElement} */ ($('#sign-in'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(form, async () => {
      const { email, password } = formValues(form);
      try {
        const profile = await api('POST', '/api/v1/auth/login', { email, password });
        app.state.prefillEmail = '';
        app.setProfile(profile);
        app.navigate(profile.activeRole ? profile.landing : '/select-role', { replace: true });
      } catch (error) {
        showMessage(errorText(error));
        /** @type {HTMLInputElement} */ ($('#password')).value = '';
      }
    });
  });
}

/** @param {App} app */
export function selectRoleView(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  app.root.innerHTML = authLayout({
    title: t('chooseRoleTitle'),
    subtitle: t('chooseRoleSubtitle'),
    body: `
      <div class="d-grid gap-2">
        ${profile.roles
          .map(
            (option) => `
          <button type="button" class="btn btn-outline-secondary btn-lg text-start role-option${
            option.roleAssignmentId === profile.activeRole?.roleAssignmentId ? ' active' : ''
          }" data-role="${esc(option.roleAssignmentId)}">
            <span class="d-block fw-semibold">${esc(t(`role_${option.role}`))}</span>
            ${option.tenantName ? `<span class="d-block small">${esc(option.tenantName)}</span>` : ''}
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
