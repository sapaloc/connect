const ESCAPES = /** @type {Record<string, string>} */ ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/** Escapes a value for use inside HTML text or a quoted attribute. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement}
 */
export function $(selector, root = document) {
  return /** @type {HTMLElement} */ (root.querySelector(selector));
}

/**
 * @param {HTMLFormElement} form
 * @returns {Record<string, string>}
 */
export function formValues(form) {
  return Object.fromEntries([...new FormData(form).entries()].map(([key, value]) => [key, String(value)]));
}

/**
 * Disables the submit button while `work` runs.
 * @param {HTMLFormElement} form
 * @param {() => Promise<void>} work
 */
export async function busy(form, work) {
  const button = /** @type {HTMLButtonElement | null} */ (form.querySelector('[type="submit"]'));
  if (button) button.disabled = true;
  try {
    await work();
  } finally {
    if (button) button.disabled = false;
  }
}
