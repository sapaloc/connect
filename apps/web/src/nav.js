/**
 * Pages reachable from the navigation. A page shows only when the active role holds
 * `surface.<surface>` and, when set, `permission` (permission by absence, §18.1).
 * @typedef {{
 *   path: string,
 *   surface: 'console' | 'counter' | 'my',
 *   label: string,
 *   icon: IconName,
 *   permission?: string,
 *   tenantScoped?: boolean,
 * }} NavItem
 */

/** @type {NavItem[]} */
export const NAV = [
  { path: '/console', surface: 'console', label: 'nav_home', icon: 'home' },
  { path: '/console/team', surface: 'console', label: 'nav_team', icon: 'team', permission: 'user.list', tenantScoped: true },
  { path: '/counter', surface: 'counter', label: 'nav_counter', icon: 'scan' },
  { path: '/my', surface: 'my', label: 'nav_my', icon: 'qr' },
];

/**
 * @param {import('./api.js').Profile} profile
 * @param {NavItem} item
 */
export function canOpen(profile, item) {
  if (!profile.permissions.includes(`surface.${item.surface}`)) return false;
  if (item.permission && !profile.permissions.includes(item.permission)) return false;
  if (item.tenantScoped && !profile.activeRole?.tenantId) return false;
  return true;
}

/** @param {import('./api.js').Profile} profile */
export function visibleNav(profile) {
  return NAV.filter((item) => canOpen(profile, item));
}

/** @param {string} path */
export function navItem(path) {
  return NAV.find((item) => item.path === path) ?? null;
}

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5h4v5"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M18.5 14.8c1.7.8 2.7 2.5 3 5.2"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M4 12h16"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  theme: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  logout: '<path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 16l-4-4 4-4M6 12h9"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>',
};

/** @typedef {keyof typeof ICONS} IconName */

/** @param {IconName} name */
export function icon(name) {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}
