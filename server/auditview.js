import { db } from './db.js';

// Menerjemahkan baris audit_log (detail JSON mentah berisi ID) menjadi tampilan yang bisa dibaca supervisor:
//   target_label : "Boy" / "RM-0012 · Siti" / "Layanan 3 · Pijat" (bukan "user #3")
//   summary      : satu kalimat ringkas untuk kolom tabel
//   items        : [{ label, value }] atau [{ label, at: ISO }] untuk modal rincian (at diformat di browser)
// Data mentah di database TIDAK diubah; ini hanya lapisan tampilan.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const ROLE = { user: 'User', admin: 'Admin', supervisor: 'Supervisor' };
const EMP = { tetap: 'Karyawan tetap', part_time: 'Part time' };
const ORIGIN = { awal: 'Data awal', baru: 'Customer baru' };
const FIELD_LABEL = {
  rm_no: 'No RM', reimburse: 'Reimburse', name: 'Nama', gender: 'Jenis Kelamin', birth_date: 'Tgl Lahir', phone: 'No WA',
  occupation: 'Pekerjaan', domicile: 'Domisili', month: 'Bulan', reference: 'Referensi', medical_note: 'SOAP', origin: 'Asal data',
};
const SCHEDULE_FIELD_LABEL = {
  user_id: 'User', customer_id: 'Customer', day: 'Tanggal', start_time: 'Jam mulai', end_time: 'Jam selesai', note: 'Catatan', service_ids: 'Layanan',
};
const SOAP_PART_LABEL = { s: 'Subjective', o: 'Objective', a: 'Assessment', p: 'Planning' };
const SCHEDULE_STATUS = { baru: 'Baru', berjalan: 'Sedang dijalani', selesai: 'Selesai', batal: 'Dibatalkan' };
const KEY_LABEL = {
  user_id: 'Pengguna', customer_id: 'Customer', service_id: 'Layanan', commission: 'Komisi', day: 'Tanggal', late: 'Terlambat',
  username: 'Username', name: 'Nama', role: 'Peran', employment: 'Status kerja', active: 'Aktif', position: 'Posisi', added: 'Ditambahkan',
  updated: 'Diperbarui', skipped: 'Dilewati', rm_no: 'No RM', origin: 'Asal data', fields: 'Kolom diubah', reviewed_by: 'Di-approve oleh',
  reviewed_at: 'Waktu approve',
};

const rp = (n) => `Rp${String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
const num = (n) => String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const yesNo = (b) => (b ? 'Ya' : 'Tidak');
const statusLate = (late) => (late ? 'Terlambat' : 'Tepat waktu');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function dayText(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(ymd ?? '–');
}

function parse(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return { catatan: raw }; }
}

// Pencarian nama memakai satu kali query per jenis per halaman (maks 50 baris), bukan satu per baris.
function makeLookup(entries) {
  const ids = { user: new Set(), customer: new Set(), service: new Set() };
  const add = (k, v) => { const n = Number(v); if (Number.isInteger(n) && n > 0) ids[k].add(n); };
  for (const { row, d } of entries) {
    if (row.target_type === 'user') add('user', row.target_id);
    if (row.target_type === 'customer') add('customer', row.target_id);
    if (row.target_type === 'service') add('service', row.target_id);
    if (isObj(d)) {
      add('user', d.user_id); add('user', d.reviewed_by);
      add('customer', d.customer_id); add('service', d.service_id);
      if (isObj(d.changes) && row.action === 'commission.update') for (const k of Object.keys(d.changes)) add('service', k);
    }
    if (row.target_type === 'day_review') add('user', String(row.target_id).split(':')[0]);
  }
  const load = (table, cols, set) => {
    const list = [...set];
    if (!list.length) return new Map();
    const rows = db.prepare(`SELECT id, ${cols} FROM ${table} WHERE id IN (${list.map(() => '?').join(',')})`).all(...list);
    return new Map(rows.map((r) => [r.id, r]));
  };
  const users = load('users', 'name', ids.user);
  const customers = load('customers', 'rm_no, name', ids.customer);
  const services = load('services', 'position, name', ids.service);
  return {
    user: (id) => users.get(Number(id))?.name || `user #${id}`,
    customer: (id) => {
      const c = customers.get(Number(id));
      return c ? `${c.rm_no ? `${c.rm_no} · ` : ''}${c.name}` : `customer #${id}`;
    },
    service: (id) => {
      const s = services.get(Number(id));
      return s ? s.name : `layanan #${id}`;
    },
  };
}

function targetLabel(row, L) {
  const id = row.target_id;
  switch (row.target_type) {
    case 'user': return id ? L.user(id) : '–';
    case 'customer': return id ? L.customer(id) : '(banyak customer)';
    case 'service': return id ? L.service(id) : '–';
    case 'record': return id ? `Data layanan #${id}` : '–';
    case 'schedule': return id ? `Jadwal #${id}` : '–';
    case 'day_review': {
      const [uid, day] = String(id).split(':');
      return day ? `${L.user(uid)} · ${dayText(day)}` : L.user(uid);
    }
    default: return (row.target_type || id) ? `${row.target_type || ''}${id ? ` #${id}` : ''}`.trim() : '–';
  }
}

// Kelompokkan perubahan komisi yang nilainya sama supaya tidak ada 29 baris berulang.
function commissionItems(changes, L) {
  const groups = new Map();
  for (const [sid, ch] of Object.entries(changes || {})) {
    const key = `${ch?.from}→${ch?.to}`;
    if (!groups.has(key)) groups.set(key, { from: ch?.from, to: ch?.to, names: [] });
    groups.get(key).names.push(L.service(sid));
  }
  return [...groups.values()].map((g) => ({
    label: `${rp(g.from)} → ${rp(g.to)}`,
    value: `${g.names.length} layanan: ${g.names.join(', ')}`,
  }));
}

function fieldChange(label, from, to, fmt = (x) => x) {
  return { label, value: `${fmt(from)} → ${fmt(to)}` };
}

function describe(row, d, L) {
  const actor = row.actor_name || 'Seseorang';
  switch (row.action) {
    case 'record.delete': {
      const cust = L.customer(d.customer_id);
      return {
        summary: `Menghapus layanan ${L.service(d.service_id)} untuk ${cust} (${dayText(d.day)})`,
        items: [
          { label: 'Terapis', value: L.user(d.user_id) }, { label: 'Customer', value: cust },
          { label: 'Layanan', value: L.service(d.service_id) }, { label: 'Komisi', value: rp(d.commission) },
          { label: 'Tanggal data', value: dayText(d.day) },
        ],
      };
    }
    case 'review.approve':
      return {
        summary: `Approve data ${L.user(row.target_id)} tanggal ${dayText(d.day)}: ${statusLate(d.late)}`,
        items: [{ label: 'Terapis', value: L.user(row.target_id) }, { label: 'Tanggal data', value: dayText(d.day) }, { label: 'Status', value: statusLate(d.late) }],
      };
    case 'review.change':
      return {
        summary: `Ubah approve ${L.user(row.target_id)} tanggal ${dayText(d.day)}: ${statusLate(d.from_late)} → ${statusLate(d.to_late)}`,
        items: [
          { label: 'Terapis', value: L.user(row.target_id) }, { label: 'Tanggal data', value: dayText(d.day) },
          { label: 'Status sebelumnya', value: statusLate(d.from_late) }, { label: 'Status sekarang', value: statusLate(d.to_late) },
        ],
      };
    case 'review.cancel':
      return {
        summary: `Membatalkan approve ${L.user(d.user_id)} tanggal ${dayText(d.day)} (sebelumnya ${statusLate(d.late).toLowerCase()})`,
        items: [
          { label: 'Terapis', value: L.user(d.user_id) }, { label: 'Tanggal data', value: dayText(d.day) },
          { label: 'Status yang dibatalkan', value: statusLate(d.late) }, { label: 'Semula di-approve oleh', value: L.user(d.reviewed_by) },
          ...(d.reviewed_at ? [{ label: 'Waktu approve semula', at: d.reviewed_at }] : []),
        ],
      };
    case 'commission.update': {
      const n = Object.keys(d.changes || {}).length;
      const hist = d.apply_to_history ? `riwayat ikut diubah (${num(d.history_rows_changed)} data)` : 'riwayat lama tidak diubah';
      return {
        summary: `Komisi ${L.user(d.user_id ?? row.target_id)}: ${num(n)} layanan diubah; ${hist}`,
        items: [
          { label: 'Terapis', value: L.user(d.user_id ?? row.target_id) },
          { label: 'Berlaku ke riwayat lama', value: d.apply_to_history ? `Ya, ${num(d.history_rows_changed)} data diperbarui` : 'Tidak, hanya untuk data baru' },
          ...commissionItems(d.changes, L),
        ],
      };
    }
    case 'account.create':
      return {
        summary: `Membuat akun ${d.name || d.username} (${ROLE[d.role] || d.role}, ${EMP[d.employment] || d.employment})`,
        items: [
          { label: 'Nama', value: d.name }, { label: 'Username', value: d.username },
          { label: 'Peran', value: ROLE[d.role] || d.role }, { label: 'Status kerja', value: EMP[d.employment] || d.employment },
        ],
      };
    case 'account.update': {
      const c = d.changes || {};
      const items = [{ label: 'Akun', value: `${L.user(row.target_id)}${d.username ? ` (${d.username})` : ''}` }];
      const parts = [];
      if (c.name) { items.push(fieldChange('Nama', c.name.from, c.name.to)); parts.push('nama'); }
      if (c.active) { items.push(fieldChange('Status akun', c.active.from, c.active.to, (x) => (x ? 'Aktif' : 'Nonaktif'))); parts.push(c.active.to ? 'diaktifkan' : 'dinonaktifkan'); }
      if (c.role) { items.push(fieldChange('Peran', c.role.from, c.role.to, (x) => ROLE[x] || x)); parts.push('peran'); }
      if (c.employment) { items.push(fieldChange('Status kerja', c.employment.from, c.employment.to, (x) => EMP[x] || x)); parts.push('status kerja'); }
      if (c.password_changed) { items.push({ label: 'Password', value: 'Diganti oleh supervisor' }); parts.push('password'); }
      return { summary: `Mengubah akun ${L.user(row.target_id)}${parts.length ? `: ${parts.join(', ')}` : ''}`, items };
    }
    case 'service.update': {
      const c = d.changes || {};
      const items = [{ label: 'Kotak layanan', value: `Posisi ${d.position ?? '–'}` }];
      const parts = [];
      if (c.name) { items.push(fieldChange('Nama layanan', c.name.from, c.name.to)); parts.push(`nama menjadi “${c.name.to}”`); }
      if (c.photo) {
        const msg = !c.photo.from ? 'Foto ditambahkan' : (!c.photo.to ? 'Foto dihapus' : 'Foto diganti');
        items.push({ label: 'Foto', value: msg }); parts.push(msg.toLowerCase());
      }
      return { summary: `Mengubah layanan posisi ${d.position ?? '–'}${parts.length ? `: ${parts.join(', ')}` : ''}`, items };
    }
    case 'customer.import':
      return {
        summary: `Impor data customer: ${num(d.added)} ditambahkan, ${num(d.updated)} diperbarui, ${num(d.skipped)} dilewati`,
        items: [{ label: 'Ditambahkan', value: num(d.added) }, { label: 'Diperbarui', value: num(d.updated) }, { label: 'Dilewati', value: num(d.skipped) }],
      };
    case 'customer.create':
      return {
        summary: `Menambah customer ${L.customer(row.target_id)} (${ORIGIN[d.origin] || d.origin || '–'})`,
        items: [{ label: 'Customer', value: L.customer(row.target_id) }, { label: 'No RM', value: d.rm_no }, { label: 'Asal data', value: ORIGIN[d.origin] || d.origin || '–' }],
      };
    case 'customer.update': {
      const cols = (Array.isArray(d.fields) ? d.fields : []).map((f) => FIELD_LABEL[f] || f);
      return {
        summary: `Mengubah customer ${L.customer(row.target_id)}: ${cols.length ? cols.join(', ') : 'tidak ada kolom berubah'}`,
        items: [
          { label: 'Customer', value: L.customer(row.target_id) },
          { label: 'Kolom yang diubah', value: cols.length ? cols.join(', ') : '–' },
          { label: 'Catatan', value: 'Isi data pribadi/SOAP tidak disimpan di log, hanya nama kolomnya.' },
        ],
      };
    }
    case 'schedule.create':
      return {
        summary: `Membuat jadwal ${L.user(d.user_id)} untuk ${L.customer(d.customer_id)} (${dayText(d.day)} ${d.start_time || ''})`.trim(),
        items: [
          { label: 'User', value: L.user(d.user_id) }, { label: 'Customer', value: L.customer(d.customer_id) },
          { label: 'Tanggal', value: dayText(d.day) }, { label: 'Jam mulai', value: d.start_time || '–' },
          { label: 'Jumlah layanan', value: num(d.services) },
        ],
      };
    case 'schedule.update': {
      const cols = (Array.isArray(d.fields) ? d.fields : []).map((f) => SCHEDULE_FIELD_LABEL[f] || f);
      return {
        summary: `Mengubah jadwal #${row.target_id}: ${cols.length ? cols.join(', ') : 'tidak ada kolom berubah'}`,
        items: [
          { label: 'Jadwal', value: `#${row.target_id}` },
          { label: 'Kolom yang diubah', value: cols.length ? cols.join(', ') : '–' },
          { label: 'Catatan', value: 'Isi catatan tidak disimpan di log, hanya nama kolomnya.' },
        ],
      };
    }
    case 'schedule.cancel':
      return {
        summary: `Membatalkan jadwal ${L.user(d.user_id)} untuk ${L.customer(d.customer_id)} (${dayText(d.day)})`,
        items: [
          { label: 'User', value: L.user(d.user_id) }, { label: 'Customer', value: L.customer(d.customer_id) },
          { label: 'Tanggal', value: dayText(d.day) }, { label: 'Status sebelumnya', value: SCHEDULE_STATUS[d.from] || d.from || '–' },
        ],
      };
    case 'schedule.start':
      return {
        summary: `Memulai jadwal #${row.target_id} untuk ${L.customer(d.customer_id)} (${dayText(d.day)})`,
        items: [{ label: 'Jadwal', value: `#${row.target_id}` }, { label: 'Customer', value: L.customer(d.customer_id) }, { label: 'Tanggal', value: dayText(d.day) }],
      };
    case 'schedule.complete':
      return {
        summary: `Menyelesaikan jadwal #${row.target_id} untuk ${L.customer(d.customer_id)} (${dayText(d.day)})`,
        items: [
          { label: 'Jadwal', value: `#${row.target_id}` }, { label: 'Customer', value: L.customer(d.customer_id) },
          { label: 'Tanggal', value: dayText(d.day) }, { label: 'Jumlah layanan', value: num(d.services) },
          { label: 'Bagian SOAP terisi', value: (Array.isArray(d.soap_parts) ? d.soap_parts : []).map((k) => SOAP_PART_LABEL[k] || k).join(', ') || '–' },
          { label: 'Catatan', value: 'Isi SOAP tidak disimpan di log, hanya nama bagiannya.' },
        ],
      };
    case 'auth.password_change':
      return { summary: `${actor} mengganti password miliknya sendiri`, items: [{ label: 'Keterangan', value: 'Password diganti oleh pemilik akun. Sesi di perangkat lain otomatis keluar.' }] };
    default:
      return null;
  }
}

// Cadangan untuk aksi yang belum dikenal: tetap diterjemahkan semampunya, tidak menampilkan JSON mentah.
function genericItems(d, L) {
  const fmt = (k, v) => {
    if (v == null || v === '') return '–';
    if (typeof v === 'boolean') return yesNo(v);
    if (k === 'user_id' || k === 'reviewed_by') return L.user(v);
    if (k === 'customer_id') return L.customer(v);
    if (k === 'service_id') return L.service(v);
    if (k === 'day') return dayText(v);
    if (Array.isArray(v)) return v.map((x) => (isObj(x) ? '…' : String(x))).join(', ');
    if (isObj(v)) return Object.entries(v).map(([a, b]) => `${KEY_LABEL[a] || a}: ${isObj(b) ? '…' : (typeof b === 'boolean' ? yesNo(b) : b)}`).join('; ');
    return String(v);
  };
  if (!isObj(d)) return [{ label: 'Keterangan', value: fmt('', d) }];
  return Object.entries(d).map(([k, v]) => ({ label: KEY_LABEL[k] || k.replace(/_/g, ' '), value: fmt(k, v) }));
}

export function enrichAuditRows(rows) {
  const entries = rows.map((row) => ({ row, d: parse(row.detail) }));
  const L = makeLookup(entries);
  return entries.map(({ row, d }) => {
    let out = null;
    try { out = describe(row, isObj(d) ? d : {}, L); } catch { out = null; }
    const items = (out?.items || genericItems(d, L)).filter((i) => i && (i.at || (i.value !== undefined && i.value !== null)));
    const summary = out?.summary || items.slice(0, 4).map((i) => `${i.label}: ${i.value ?? ''}`).join('; ');
    return { ...row, target_label: targetLabel(row, L), summary, items };
  });
}
