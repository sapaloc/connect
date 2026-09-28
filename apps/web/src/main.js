import 'bootstrap/dist/css/bootstrap.min.css';
import './styles.css';
import { surfaceOf } from '@connect/domain';
import { api, fetchProfile, SESSION_ENDED } from './api.js';
import { errorText, getLang, setLang, t } from './i18n.js';
import { forgotView, inviteView, loginView, resetView, selectRoleView } from './views/auth.js';
import { showMessage } from './views/common.js';
import { consoleView, counterView, myView } from './views/shell.js';

/**
 * @typedef {{
 *   root: HTMLElement,
 *   state: { profile: import('./api.js').Profile | null, prefillEmail: string, linkToken: string },
 *   navigate: (path: string, options?: { replace?: boolean }) => void,
 *   setProfile: (profile: import('./api.js').Profile | null) => void,
 *   flash: (text: string, tone?: 'error' | 'success' | 'info') => void,
 *   consumeFlash: () => void,
 * }} App
 */

/** @type {Record<string, (app: App) => void>} */
const PUBLIC_ROUTES = { '/login': loginView, '/forgot': forgotView, '/invite': inviteView, '/reset': resetView };

/** @type {Record<string, (app: App) => void>} */
const SURFACE_ROUTES = { '/console': consoleView, '/counter': counterView, '/my': myView };

/** @type {{ text: string, tone: 'error' | 'success' | 'info' } | null} */
let pendingFlash = null;

/** @type {App} */
const app = {
  root: /** @type {HTMLElement} */ (document.getElementById('app')),
  state: { profile: null, prefillEmail: '', linkToken: '' },
  navigate(path, { replace = false } = {}) {
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
    route();
  },
  setProfile(profile) {
    app.state.profile = profile;
  },
  flash(text, tone = 'info') {
    pendingFlash = { text, tone };
  },
  consumeFlash() {
    if (pendingFlash) showMessage(pendingFlash.text, pendingFlash.tone);
    pendingFlash = null;
  },
};

/**
 * Every path passes this guard. The API enforces the same rules; this only keeps people
 * on screens their role can use (E2E-S1-01: Staff typing /console lands on the scanner).
 */
function route() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const profile = app.state.profile;
  document.documentElement.lang = getLang();

  if (PUBLIC_ROUTES[path]) {
    if (path === '/login' && profile?.activeRole) return app.navigate(/** @type {string} */ (profile.landing), { replace: true });
    PUBLIC_ROUTES[path](app);
    return loadHealth();
  }
  if (!profile) return app.navigate('/login', { replace: true });
  if (path === '/select-role') return selectRoleView(app);
  if (!profile.activeRole) return app.navigate('/select-role', { replace: true });

  const surface = surfaceOf(path);
  const view = SURFACE_ROUTES[path];
  if (!surface || !view || !profile.permissions.includes(`surface.${surface}`)) {
    return app.navigate(/** @type {string} */ (profile.landing), { replace: true });
  }
  view(app);
}

async function signOut() {
  await api('POST', '/api/v1/auth/logout').catch(() => {});
  app.setProfile(null);
  app.navigate('/login', { replace: true });
}

async function loadHealth() {
  const status = document.getElementById('status');
  if (!status) return;
  let ok = false;
  let detail = '';
  try {
    const res = await fetch('/api/v1/health', { headers: { Accept: 'application/json' } });
    const body = await res.json();
    ok = res.ok && body.db === 'ok';
    detail = [body.env, body.commit].filter(Boolean).join(' · ');
  } catch {
    ok = false;
  }
  status.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = `dot ${ok ? 'dot-ok' : 'dot-down'}`;
  status.append(dot, `${t(ok ? 'statusOk' : 'statusDown')}${detail ? ` · ${detail}` : ''}`);
}

document.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const link = /** @type {HTMLAnchorElement | null} */ (target.closest('a[data-nav]'));
  if (link && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    app.navigate(link.getAttribute('href') ?? '/');
    return;
  }
  const lang = target.closest('[data-lang]');
  if (lang) {
    setLang(lang.getAttribute('data-lang') ?? 'vi');
    route();
    return;
  }
  if (target.closest('[data-signout]')) {
    event.preventDefault();
    signOut();
  }
});

window.addEventListener('popstate', route);

window.addEventListener(SESSION_ENDED, () => {
  if (!app.state.profile) return;
  app.state.prefillEmail = app.state.profile.user.email;
  app.setProfile(null);
  app.flash(errorText({ code: 'UNAUTHENTICATED' }), 'info');
  app.navigate('/login', { replace: true });
});

fetchProfile()
  .catch(() => null)
  .then((profile) => {
    app.setProfile(profile);
    route();
  });
