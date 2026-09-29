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
  { path: '/console/merchants', surface: 'console', label: 'nav_merchants', icon: 'store', permission: 'merchant.manage' },
  { path: '/console/vouchers', surface: 'console', label: 'nav_vouchers', icon: 'ticket', permission: 'voucher.list' },
  { path: '/console/partners', surface: 'console', label: 'nav_partners', icon: 'handshake', permission: 'partner.list' },
  { path: '/console/brand', surface: 'console', label: 'nav_brand', icon: 'palette', permission: 'merchant.settings', tenantScoped: true },
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
  store: '<path d="M4 9.5 5.5 4h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5.5 12v8h13v-8"/><path d="M10 20v-4.5h4V20"/>',
  ticket: '<path d="M3.5 8.5V6a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v2.5a2.5 2.5 0 0 0 0 5V18a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-4.5a2.5 2.5 0 0 0 0-5z"/><path d="M9.5 9.5l5 5M14.5 9.5h.01M9.5 14.5h.01"/>',
  handshake:
    '<path d="M2.5 11.5 6 8l3 1.5L12 8l3 1.5L18 8l3.5 3.5"/><path d="M6 8v6.5l4.5 4a1.5 1.5 0 0 0 2 0l5.5-4.5V8"/><path d="M9.5 13.5l2 2M12 11.5l2.5 2.5"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M18.5 14.8c1.7.8 2.7 2.5 3 5.2"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M4 12h16"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.6 0-.9.7-1.5 1.7-1.5h2.2a3.8 3.8 0 0 0 3.8-3.8C20.5 6.9 16.7 3.5 12 3.5z"/><circle cx="7.8" cy="11" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M4 4l16 16"/><path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.2 7.4C3.9 9 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
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
