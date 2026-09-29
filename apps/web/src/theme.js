const STORAGE_KEY = 'connect.theme';

/** @returns {'light' | 'dark'} */
export function getTheme() {
  return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
}

export function applyTheme() {
  const dark = getTheme() === 'dark';
  document.documentElement.classList.toggle('forest-dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#102220' : '#28332C');
}

export function toggleTheme() {
  localStorage.setItem(STORAGE_KEY, getTheme() === 'dark' ? 'light' : 'dark');
  applyTheme();
}
