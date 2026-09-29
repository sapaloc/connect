import { esc } from '../dom.js';
import { getLang, t } from '../i18n.js';
import { icon, navItem, visibleNav } from '../nav.js';
import { getTheme } from '../theme.js';
import { counterPanel, mountCounter } from './counter.js';
import { merchantsPanel, mountMerchants } from './merchants.js';
import { mountMy, myPanel } from './my.js';
import { mountPartners, partnersPanel } from './partners.js';
import { mountTeam, teamPanel } from './team.js';
import { mountVouchers, vouchersPanel } from './vouchers.js';

/** @typedef {import('../main.js').App} App */
/** @typedef {import('../nav.js').NavItem} NavItem */

/** @param {string} name */
function initials(name) {
  return name
    .split(/\s+/)
    .filter((part) => /\p{L}/u.test(part))
    .slice(-2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

/**
 * @param {NavItem} item
 * @param {string} current
 * @param {string} className
 */
function navLink(item, current, className) {
  const active = item.path === current;
  return `
    <a href="${item.path}" data-nav class="${className}${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>
      ${icon(item.icon)}<span>${esc(t(item.label))}</span>
    </a>`;
}

/**
 * Signed-in frame, mobile first:
 * phone = top bar + bottom tabs + drawer, tablet = icon rail, desktop = 232px sidebar.
 * @param {App} app
 * @param {string} current
 * @param {{ title: string, content: string }} page
 */
export function appLayout(app, current, { title, content }) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  const role = /** @type {import('../api.js').RoleOption} */ (profile.activeRole);
  const items = visibleNav(profile);
  const surfaces = [...new Set(items.map((item) => item.surface))];
  const roleLine = `${t(`role_${role.role}`)}${role.tenantName ? ` · ${role.tenantName}` : ''}`;
  const otherLang = getLang() === 'en' ? 'vi' : 'en';
  const dark = getTheme() === 'dark';

  const sideNav = surfaces
    .map(
      (surface) => `
        ${surfaces.length > 1 ? `<div class="sb-sec">${esc(t(`surface_${surface}`))}</div>` : ''}
        ${items
          .filter((item) => item.surface === surface)
          .map((item) => navLink(item, current, 'sb-link'))
          .join('')}`,
    )
    .join('');

  return `
    <div class="app" id="app-frame">
      <a class="skip-link" href="#main">${esc(t('skipToContent'))}</a>
      <aside class="sb" id="sidebar" aria-label="${esc(t('menu'))}">
        <div class="sb-head">
          <span class="brand brand-on-dark">MYCONNECT</span>
          <span class="brand-mark" aria-hidden="true">M</span>
          <button type="button" class="icon-btn sb-close" data-drawer="close" aria-label="${esc(t('closeMenu'))}">${icon('close')}</button>
        </div>
        <nav class="sb-nav">${sideNav}</nav>
        <div class="sb-foot">
          <div class="sb-who" title="${esc(profile.user.email)}">
            <span class="avatar" aria-hidden="true">${esc(initials(profile.user.displayName))}</span>
            <span class="sb-who-text">
              <span class="d-block fw-semibold text-truncate">${esc(profile.user.displayName)}</span>
              <span class="d-block small text-truncate">${esc(roleLine)}</span>
            </span>
          </div>
          <div class="sb-actions">
            ${
              profile.roles.length > 1
                ? `<a href="/select-role" data-nav class="sb-action" title="${esc(t('switchRole'))}">${icon('swap')}<span>${esc(t('switchRole'))}</span></a>`
                : ''
            }
            <button type="button" class="sb-action" data-lang="${otherLang}" title="${esc(t('language'))}">
              ${icon('globe')}<span>${esc(t('language'))}: ${getLang().toUpperCase()}</span>
            </button>
            <button type="button" class="sb-action" data-theme aria-pressed="${dark}" title="${esc(t('darkTheme'))}">
              ${icon('theme')}<span>${esc(t('darkTheme'))}</span>
            </button>
            <button type="button" class="sb-action" data-signout title="${esc(t('signOut'))}">
              ${icon('logout')}<span>${esc(t('signOut'))}</span>
            </button>
          </div>
        </div>
      </aside>
      <div class="sb-backdrop" data-drawer="close"></div>
      <div class="app-body">
        <header class="tb">
          <button type="button" class="icon-btn tb-menu" data-drawer="open" aria-controls="sidebar" aria-expanded="false" aria-label="${esc(t('menu'))}">${icon('menu')}</button>
          <h1 class="tb-title">${esc(title)}</h1>
          <span class="tb-who">
            <span class="d-block fw-semibold">${esc(profile.user.displayName)}</span>
            <span class="d-block small">${esc(roleLine)}</span>
          </span>
        </header>
        <main class="app-main" id="main" tabindex="-1">${content}</main>
      </div>
      ${
        items.length > 1
          ? `<nav class="bn" aria-label="${esc(t('menu'))}">${items.slice(0, 5).map((item) => navLink(item, current, 'bn-link')).join('')}</nav>`
          : ''
      }
    </div>`;
}

/**
 * @param {string} title
 * @param {string} text
 * @param {import('../nav.js').IconName} [iconName]
 */
export function emptyState(title, text, iconName = 'home') {
  return `
    <div class="empty">
      <span class="empty-ico">${icon(iconName)}</span>
      <p class="fw-semibold mb-1">${esc(title)}</p>
      <p class="text-muted small mb-0">${esc(text)}</p>
    </div>`;
}

/**
 * @param {App} app
 * @param {string} path
 * @param {string} content
 */
function render(app, path, content) {
  const item = navItem(path);
  app.root.innerHTML = appLayout(app, path, { title: item ? t(item.label) : '', content });
}

/** @param {App} app */
export function consoleView(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  const shortcuts = visibleNav(profile).filter((item) => item.path !== '/console');
  render(
    app,
    '/console',
    `
    <section class="page-head">
      <p class="eyebrow">${esc(t('surface_console'))}</p>
      <h2 class="h4 mb-0">${esc(t('hello', { name: profile.user.displayName }))}</h2>
    </section>
    <div class="grid-2">
      <section class="card-sw">
        <h3 class="card-title">${esc(t('workTitle'))}</h3>
        ${emptyState(t('workNothing'), t('workEmpty'))}
      </section>
      ${
        shortcuts.length
          ? `<section class="card-sw">
              <h3 class="card-title">${esc(t('shortcuts'))}</h3>
              <div class="shortcut-list">
                ${shortcuts.map((item) => `<a href="${item.path}" data-nav class="shortcut">${icon(item.icon)}<span>${esc(t(item.label))}</span></a>`).join('')}
              </div>
            </section>`
          : ''
      }
    </div>`,
  );
}

/** @param {App} app */
export function teamView(app) {
  render(app, '/console/team', teamPanel(/** @type {import('../api.js').Profile} */ (app.state.profile)));
  mountTeam(app);
}

/** @param {App} app */
export function merchantsView(app) {
  render(app, '/console/merchants', merchantsPanel());
  mountMerchants(app);
}

/** @param {App} app */
export function vouchersView(app) {
  render(app, '/console/vouchers', vouchersPanel(app));
  mountVouchers(app);
}

/** @param {App} app */
export function partnersView(app) {
  render(app, '/console/partners', partnersPanel(app));
  mountPartners(app);
}

/** @param {App} app */
export function counterView(app) {
  render(app, '/counter', counterPanel());
  mountCounter(app);
}

/** @param {App} app */
export function myView(app) {
  render(app, '/my', myPanel());
  mountMy(app);
}
