// Profil akun: info akun, data diri, foto, dan ganti password. Dibuka dari tombol nama di topbar
// oleh semua peran (user, admin, supervisor); setiap orang hanya mengubah akunnya sendiri.
import { api } from './api.js';
import { h, icon, openModal, toast, field, ROLE_LABEL, EMP_LABEL } from './ui.js';

export const initials = (name) => {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};

// Lingkaran foto; tanpa foto menampilkan inisial. Dipakai di topbar dan di modal profil.
export function avatar(user, size = 32) {
  const el = h('span', { class: 'avatar', 'aria-hidden': 'true' });
  el.style.setProperty('--sz', `${size}px`);
  paintAvatar(el, user);
  return el;
}
export function paintAvatar(el, user) {
  el.replaceChildren();
  if (user?.photo) el.append(h('img', { src: user.photo, alt: '', loading: 'lazy' }));
  else el.append(initials(user?.name));
}

// Kecilkan foto di browser (sisi terpanjang 512 px, JPEG) supaya selalu di bawah batas unggah server.
async function toDataUrl(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Foto harus berformat JPG, PNG, atau WebP');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Foto tidak bisa dibaca')); i.src = url; });
    const scale = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt);
    ctx.drawImage(img, 0, 0, w, hgt);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

// onChange(user) dipanggil setelah profil tersimpan, supaya topbar ikut berubah.
export async function openProfileModal(user, onChange) {
  const body = h('div', { class: 'profile' }, h('p', { class: 'muted' }, 'Memuat…'));
  const modal = openModal({ title: 'Profil saya', content: body, wide: true });
  let profile;
  try { ({ profile } = await api('/api/auth/profile')); } catch (e) { body.replaceChildren(h('p', { class: 'error' }, e.message || 'Profil belum bisa dimuat')); return; }

  let photo; // undefined = tidak diubah, null = hapus, string = foto baru (data URL)
  const preview = avatar({ name: profile.name, photo: profile.photo }, 88);
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'sr-only', id: 'pf-file', tabindex: '-1' });
  const removeBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Hapus foto');
  removeBtn.hidden = !profile.photo;
  const err = h('p', { class: 'error', role: 'alert' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    err.textContent = '';
    try { photo = await toDataUrl(f); paintAvatar(preview, { name: name.value, photo }); removeBtn.hidden = false; } catch (ex) { err.textContent = ex.message; }
  });
  removeBtn.addEventListener('click', () => { photo = null; paintAvatar(preview, { name: name.value, photo: null }); removeBtn.hidden = true; });

  const name = h('input', { class: 'input', type: 'text', maxlength: '100', value: profile.name, autocomplete: 'name' });
  const phone = h('input', { class: 'input', type: 'tel', maxlength: '30', value: profile.phone, autocomplete: 'tel', inputmode: 'tel' });
  const email = h('input', { class: 'input', type: 'email', maxlength: '120', value: profile.email, autocomplete: 'email' });
  const birth = h('input', { class: 'input', type: 'date', value: profile.birth_date, max: new Date().toISOString().slice(0, 10), autocomplete: 'bday' });
  const address = h('textarea', { class: 'input textarea', rows: '3', maxlength: '300', autocomplete: 'street-address' });
  address.value = profile.address;
  name.addEventListener('input', () => { if (!photo && !profile.photo) paintAvatar(preview, { name: name.value }); });
  const save = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Simpan profil');

  const roleLine = [ROLE_LABEL[profile.role], profile.role === 'user' ? EMP_LABEL?.[profile.employment] : null].filter(Boolean).join(' · ');
  const form = h('form', { novalidate: true },
    h('div', { class: 'profile__top' },
      preview,
      h('div', { class: 'profile__who' },
        h('b', null, profile.username), h('span', { class: 'muted' }, roleLine),
        h('div', { class: 'profile__photo-actions' },
          h('label', { class: 'btn btn--ghost btn--sm', for: 'pf-file', tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } } }, 'Pilih foto'),
          removeBtn, fileInput),
        h('p', { class: 'hint' }, 'JPG, PNG, atau WebP. Otomatis dikecilkan.'))),
    h('div', { class: 'form-grid' },
      field('Nama lengkap', name), field('No HP / WhatsApp', phone), field('Email', email), field('Tanggal lahir', birth),
      h('div', { class: 'form-grid__full' }, field('Alamat', address))),
    err,
    h('div', { class: 'modal__actions' }, save));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    err.textContent = '';
    save.disabled = true;
    try {
      const payload = { name: name.value, phone: phone.value, email: email.value, birth_date: birth.value, address: address.value };
      if (photo !== undefined) payload.photo = photo;
      const r = await api('/api/auth/profile', { method: 'PATCH', body: payload });
      Object.assign(user, { name: r.profile.name, photo: r.profile.photo });
      onChange?.(user);
      toast('Profil disimpan');
      modal.close();
    } catch (ex) { if (!ex.aborted) err.textContent = ex.message; } finally { save.disabled = false; }
  });

  // ---- ganti password ----
  const current = h('input', { class: 'input', id: 'pw-cur', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', id: 'pw-new', type: 'password', autocomplete: 'new-password' });
  const pwErr = h('p', { class: 'error', role: 'alert' });
  const pwSave = h('button', { class: 'btn btn--ghost', type: 'submit' }, 'Ganti password');
  const pwForm = h('form', { class: 'profile__pw' },
    h('h3', null, 'Ganti password'),
    h('div', { class: 'form-grid' },
      field('Password saat ini', current),
      field('Password baru', next, 'Minimal 8 karakter.')),
    pwErr, h('div', { class: 'modal__actions' }, pwSave));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pwSave.disabled) return;
    pwErr.textContent = '';
    pwSave.disabled = true;
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: current.value, next: next.value } });
      current.value = ''; next.value = '';
      toast('Password diganti');
    } catch (ex) { if (!ex.aborted) pwErr.textContent = ex.message; } finally { pwSave.disabled = false; }
  });

  body.replaceChildren(form, pwForm);
  name.focus();
}
