import { esc } from '../dom.js';
import { t } from '../i18n.js';
import { langToggle } from './common.js';
import { mountTeam, teamPanel } from './team.js';

/** @typedef {import('../main.js').App} App */

const SURFACES = ['console', 'counter', 'my'];

/**
 * Signed-in frame: only the surfaces this role may open are shown (permission by absence, §18.1).
 * @param {App} app
 * @param {string} current
 * @param {string} content
 */
function appLayout(app, current, content) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  const role = /** @type {import('../api.js').RoleOption} */ (profile.activeRole);
  const surfaces = SURFACES.filter((surface) => profile.permissions.includes(`surface.${surface}`));
  return `
    <div class="app-shell">
      <header class="topbar">
        <span class="brand">CONNECT</span>
        ${
          surfaces.length > 1
            ? `<nav class="topbar-nav">${surfaces
                .map(
                  (surface) =>
                    `<a href="/${surface}" data-nav class="${surface === current ? 'active' : ''}">${esc(t(`surface_${surface}`))}</a>`,
                )
                .join('')}</nav>`
            : ''
        }
        <div class="topbar-right">
          <span class="who">
            <span class="d-block fw-semibold">${esc(profile.user.displayName)}</span>
            <span class="d-block small">${esc(t(`role_${role.role}`))}${role.tenantName ? ` · ${esc(role.tenantName)}` : ''}</span>
          </span>
          ${profile.roles.length > 1 ? `<a href="/select-role" data-nav class="btn btn-sm btn-outline-secondary">${esc(t('switchRole'))}</a>` : ''}
          ${langToggle()}
          <button type="button" class="btn btn-sm btn-outline-secondary" data-signout>${esc(t('signOut'))}</button>
        </div>
      </header>
      <main class="app-main">${content}</main>
    </div>`;
}

/**
 * @param {string} title
 * @param {string} text
 */
function placeholder(title, text) {
  return `
    <section class="panel">
      <h1 class="h5 mb-2">${esc(title)}</h1>
      <p class="text-muted mb-0">${esc(text)}</p>
    </section>`;
}

/** @param {App} app */
export function consoleView(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  const showTeam = profile.permissions.includes('user.invite') && Boolean(profile.activeRole?.tenantId);
  app.root.innerHTML = appLayout(
    app,
    'console',
    placeholder(t('workTitle'), t('workEmpty')) + (showTeam ? teamPanel(profile) : ''),
  );
  if (showTeam) mountTeam(app);
}

/** @param {App} app */
export function counterView(app) {
  app.root.innerHTML = appLayout(app, 'counter', placeholder(t('counterTitle'), t('counterEmpty')));
}

/** @param {App} app */
export function myView(app) {
  app.root.innerHTML = appLayout(app, 'my', placeholder(t('myTitle'), t('myEmpty')));
}
