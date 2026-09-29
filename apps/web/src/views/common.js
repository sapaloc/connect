import { PASSWORD_MAX, passwordPolicyErrors } from '#domain';
import { $, esc } from '../dom.js';
import { getLang, t } from '../i18n.js';
import { icon } from '../nav.js';

const RULES = ['LENGTH', 'UPPER', 'LOWER', 'DIGIT', 'SPECIAL'];

export function langToggle() {
  const lang = getLang();
  return `
    <div class="btn-group btn-group-sm" role="group" aria-label="Language">
      ${['en', 'vi']
        .map(
          (code) =>
            `<button type="button" class="btn btn-outline-secondary${code === lang ? ' active' : ''}" data-lang="${code}">${code.toUpperCase()}</button>`,
        )
        .join('')}
    </div>`;
}

/** @param {{ href: string, label: string }} back */
export function backLink({ href, label }) {
  return `<a href="${esc(href)}" data-nav class="back-link">${icon('back')}<span>${esc(label)}</span></a>`;
}

/**
 * Centered card used by every signed-out page.
 * @param {{ title: string, subtitle?: string, body: string, back?: { href: string, label: string } }} content
 */
export function authLayout({ title, subtitle = '', body, back }) {
  return `
    <main class="auth-shell">
      <section class="auth-card">
        <header class="d-flex justify-content-between align-items-center mb-4">
          <a href="/" data-nav class="brand text-decoration-none">MYCONNECT</a>
          ${langToggle()}
        </header>
        ${back ? backLink(back) : ''}
        <h1 class="h4 mb-1">${esc(title)}</h1>
        ${subtitle ? `<p class="text-muted mb-4">${esc(subtitle)}</p>` : ''}
        ${body}
      </section>
      <footer class="status-line" id="status" role="status"></footer>
    </main>`;
}

/** @param {string} [id] */
export function messageSlot(id = 'form-message') {
  return `<p id="${id}" class="form-message small mt-3 mb-0" role="status" aria-live="polite"></p>`;
}

/**
 * @param {string} text
 * @param {'error' | 'success' | 'info'} [tone]
 * @param {string} [id]
 */
export function showMessage(text, tone = 'error', id = 'form-message') {
  const slot = $(`#${id}`);
  if (!slot) return;
  slot.textContent = text;
  slot.dataset.tone = tone;
}

/**
 * Shows a one-time link with a copy button. The link is never stored by the web app.
 * @param {string} message
 * @param {string} url
 * @param {string} [boxId]
 */
export function showLink(message, url, boxId = 'link-box') {
  const box = $(`#${boxId}`);
  box.hidden = false;
  box.innerHTML = `
    <p class="small mb-2">${esc(message)}</p>
    <div class="input-group">
      <input class="form-control" readonly value="${esc(url)}" aria-label="Link" />
      <button type="button" class="btn btn-outline-secondary" data-copy>${esc(t('copy'))}</button>
    </div>`;
  const button = /** @type {HTMLButtonElement} */ ($('[data-copy]', box));
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(url);
    button.textContent = t('copied');
  });
}

/**
 * Password input with a show/hide button (see `togglePasswordReveal`).
 * @param {{ id: string, autocomplete: string, maxlength?: number }} field
 */
export function passwordInput({ id, autocomplete, maxlength }) {
  return `
    <div class="password-field">
      <input id="${id}" name="${id}" type="password" class="form-control form-control-lg"
        autocomplete="${autocomplete}"${maxlength ? ` maxlength="${maxlength}"` : ''} required />
      <button type="button" class="password-reveal" data-reveal="${id}" aria-controls="${id}" aria-pressed="false"
        aria-label="${esc(t('showPassword'))}" title="${esc(t('showPassword'))}">${icon('eye')}</button>
    </div>`;
}

/** @param {HTMLElement} button a `[data-reveal]` button from `passwordInput` */
export function togglePasswordReveal(button) {
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById(button.dataset.reveal ?? ''));
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  const label = t(show ? 'hidePassword' : 'showPassword');
  button.setAttribute('aria-pressed', String(show));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = icon(show ? 'eyeOff' : 'eye');
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Password + repeat fields with a live checklist of the policy (§8.2). */
export function passwordFields() {
  return `
    <div class="mb-3">
      <label for="password" class="form-label">${esc(t('newPassword'))}</label>
      ${passwordInput({ id: 'password', autocomplete: 'new-password', maxlength: PASSWORD_MAX })}
    </div>
    <div class="mb-3">
      <label for="confirm" class="form-label">${esc(t('confirmPassword'))}</label>
      ${passwordInput({ id: 'confirm', autocomplete: 'new-password', maxlength: PASSWORD_MAX })}
    </div>
    <div class="policy mb-4">
      <p class="small mb-1">${esc(t('policyTitle'))}</p>
      <ul class="list-unstyled small mb-0">
        ${RULES.map((rule) => `<li data-rule="${rule}">${esc(t(`rule_${rule}`))}</li>`).join('')}
      </ul>
    </div>`;
}

/** @param {HTMLFormElement} form */
export function bindPasswordPolicy(form) {
  const input = /** @type {HTMLInputElement} */ ($('#password', form));
  const update = () => {
    const failing = new Set(passwordPolicyErrors(input.value));
    form.querySelectorAll('[data-rule]').forEach((item) => {
      item.classList.toggle('ok', input.value.length > 0 && !failing.has(item.getAttribute('data-rule') ?? ''));
    });
  };
  input.addEventListener('input', update);
  update();
}

/**
 * Returns an error text, or '' when the password and its repeat are acceptable.
 * @param {Record<string, string>} values
 */
export function passwordProblem(values) {
  if (passwordPolicyErrors(values.password).length) return t('err_PASSWORD_POLICY');
  if (values.password !== values.confirm) return t('passwordMismatch');
  return '';
}
