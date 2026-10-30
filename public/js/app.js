import { api, hooks } from './api.js';
import { renderLogin } from './login.js';
import { renderUserApp } from './user.js';
import { renderStaffApp } from './staff.js';

const root = document.getElementById('app');

function mount(user) {
  root.replaceChildren();
  (user.role === 'user' ? renderUserApp : renderStaffApp)(root, user, { onLogout: logout });
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* sesi sudah habis */ }
  renderLogin(root, mount);
}

hooks.onUnauthorized = () => renderLogin(root, mount, 'Sesi berakhir. Silakan masuk lagi.');

try {
  const { user } = await api('/api/auth/me');
  mount(user);
} catch {
  renderLogin(root, mount);
}
