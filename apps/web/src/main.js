import 'bootstrap/dist/css/bootstrap.min.css';
import './styles.css';
import { getLang, setLang, t } from './i18n.js';

/** @type {{ ok: boolean, env?: string, commit?: string } | null} */
let health = null;

function render() {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-lang]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
  });

  const status = document.getElementById('status');
  if (!health) {
    status.textContent = '';
    return;
  }
  const detail = [health.env, health.commit].filter(Boolean).join(' · ');
  status.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = `dot ${health.ok ? 'dot-ok' : 'dot-down'}`;
  status.append(dot, `${t(health.ok ? 'statusOk' : 'statusDown')}${detail ? ` · ${detail}` : ''}`);
}

async function loadHealth() {
  try {
    const res = await fetch('/api/v1/health', { headers: { Accept: 'application/json' } });
    const body = await res.json();
    health = { ok: res.ok && body.db === 'ok', env: body.env, commit: body.commit };
  } catch {
    health = { ok: false };
  }
  render();
}

document.querySelectorAll('[data-lang]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setLang(btn.getAttribute('data-lang'));
    render();
  });
});

document.getElementById('sign-in').addEventListener('submit', (event) => {
  event.preventDefault();
  document.getElementById('form-message').textContent = t('signInSoon');
});

render();
loadHealth();
