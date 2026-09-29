import { esc } from '../dom.js';
import { t } from '../i18n.js';
import { mountScan, scanBox } from './scan.js';
import { publicLayout } from './voucher-public.js';

/** @typedef {import('../main.js').App} App */

/**
 * Home: quick scan for anyone (customer checking a voucher, staff at the counter) and sign-in.
 * @param {App} app
 */
export function homeView(app) {
  const profile = app.state.profile;
  document.title = 'MyConnect';
  app.root.innerHTML = publicLayout(`
    <section class="home-hero">
      <h1 class="h4 mb-1">${esc(t('homeTitle'))}</h1>
      <p class="text-muted mb-4">${esc(t('homeTagline'))}</p>
    </section>
    ${scanBox()}
    <hr class="my-4" />
    ${
      profile?.activeRole
        ? `<a href="${esc(profile.landing ?? '/console')}" data-nav class="btn btn-outline-secondary btn-lg w-100">${esc(t('openWorkspace'))}</a>`
        : `<a href="/login" data-nav class="btn btn-outline-secondary btn-lg w-100">${esc(t('signIn'))}</a>`
    }`);
  mountScan(
    app.root,
    (code) => app.navigate(`/v/${code}`),
    (token) => app.navigate(`/r/${token}`),
  );
}
