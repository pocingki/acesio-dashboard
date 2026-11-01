import { api, hooks, abortAllRequests } from './api.js';
import { closeAllModals, setTz } from './ui.js';
import { renderLogin } from './login.js';
import { renderUserApp, resetUserState } from './user.js';
import { renderStaffApp } from './staff.js';
import { disposeActiveShell } from './shell.js';

const root = document.getElementById('app');

// true hanya selama ada sesi yang tampil. Saat false, 401 susulan diabaikan
// (login tampil SEKALI, dan keluar yang disengaja tidak memunculkan "Sesi berakhir").
let sessionActive = false;

function mount(user) {
  sessionActive = true;
  root.replaceChildren();
  (user.role === 'user' ? renderUserApp : renderStaffApp)(root, user, { onLogout: logout });
}

function endSession() {
  sessionActive = false;
  abortAllRequests(); // batalkan semua request yang masih berjalan
  closeAllModals();
  disposeActiveShell();
}

async function logout() {
  if (!sessionActive) return;
  endSession();
  resetUserState();
  root.setAttribute('inert', '');
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* sesi sudah habis atau offline */ }
  root.removeAttribute('inert');
  renderLogin(root, mount);
}

hooks.onUnauthorized = () => {
  if (!sessionActive) return;
  endSession();
  renderLogin(root, mount, 'Sesi berakhir. Silakan masuk lagi.');
};

async function boot() {
  let data;
  try {
    data = await api('/api/auth/me');
  } catch (e) {
    // 401 = belum login (normal, tanpa pesan); error lain (server mati, offline) ditampilkan.
    renderLogin(root, mount, e.status === 401 ? '' : e.message);
    return;
  }
  setTz(data.tz ?? data.user?.tz);
  mount(data.user);
}

boot();
