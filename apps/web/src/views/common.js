import { PASSWORD_MAX, passwordPolicyErrors } from '@connect/domain';
import { $, esc } from '../dom.js';
import { getLang, t } from '../i18n.js';

const RULES = ['LENGTH', 'UPPER', 'LOWER', 'DIGIT', 'SPECIAL'];

export function langToggle() {
  const lang = getLang();
  return `
    <div class="btn-group btn-group-sm" role="group" aria-label="Language">
      ${['vi', 'en']
        .map(
          (code) =>
            `<button type="button" class="btn btn-outline-secondary${code === lang ? ' active' : ''}" data-lang="${code}">${code.toUpperCase()}</button>`,
        )
        .join('')}
    </div>`;
}

/**
 * Centered card used by every signed-out page.
 * @param {{ title: string, subtitle?: string, body: string }} content
 */
export function authLayout({ title, subtitle = '', body }) {
  return `
    <main class="auth-shell">
      <section class="auth-card">
        <header class="d-flex justify-content-between align-items-center mb-4">
          <span class="brand">CONNECT</span>
          ${langToggle()}
        </header>
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

/** Password + repeat fields with a live checklist of the policy (§8.2). */
export function passwordFields() {
  return `
    <div class="mb-3">
      <label for="password" class="form-label">${esc(t('newPassword'))}</label>
      <input id="password" name="password" type="password" class="form-control form-control-lg"
        autocomplete="new-password" maxlength="${PASSWORD_MAX}" required />
    </div>
    <div class="mb-3">
      <label for="confirm" class="form-label">${esc(t('confirmPassword'))}</label>
      <input id="confirm" name="confirm" type="password" class="form-control form-control-lg"
        autocomplete="new-password" maxlength="${PASSWORD_MAX}" required />
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
