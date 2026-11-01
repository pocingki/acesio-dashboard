import { test } from 'node:test';
import assert from 'node:assert/strict';
const { rangeError, quickRange, addDays, dayState } = await import('../public/js/staff.js');
const { donutSegments, pctOf, shortLabel } = await import('../public/js/charts.js');
const { summarizeDetail } = await import('../public/js/audit.js');
const { duplicateMessage, importSummary } = await import('../public/js/customers.js');

test('periode terbalik ditolak', () => {
  assert.equal(rangeError('2026-10-02', '2026-10-01'), 'Tanggal awal tidak boleh setelah tanggal akhir');
  assert.equal(rangeError('', '2026-10-01'), '');
});
test('tombol cepat', () => {
  assert.deepEqual(quickRange('week', '2026-10-03'), { from: '2026-09-27', to: '2026-10-03' });
  assert.deepEqual(quickRange('all', '2026-10-31'), { from: '', to: '' });
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
test('donat tanpa NaN', () => {
  assert.equal(pctOf(1, 0), 0);
  assert.equal(donutSegments([{ label: 'A', value: 5 }], 5)[0].pct, 100);
  assert.ok(shortLabel('x'.repeat(60)).length <= 26);
});
test('status tanggal', () => {
  assert.equal(dayState(null, '2026-10-20', '2026-10-31').text, 'Tidak di-approve');
  assert.equal(dayState(1, '2026-10-20', '2026-10-31').text, 'Terlambat');
});
test('audit dan customer', () => {
  assert.equal(summarizeDetail('{"a":1}'), 'a: 1');
  assert.equal(summarizeDetail('{"x":"a\\u202eb"}'), 'x: a b');
  assert.match(duplicateMessage('No RM 1 sudah terdaftar'), /^No RM 1 sudah terdaftar\. /);
  assert.equal(importSummary({ added: 1, updated: 2, skipped: 3 }).processed, 6);
});
test('riwayat: satu grup per customer per hari, layanan menjadi rincian', async () => {
  const { groupRecords } = await import('../public/js/groups.js');
  const rec = (id, cid, day, svc, comm) => ({
    id, customer_id: cid, day, created_at: `${day}T03:00:00Z`, customer_rm: `RM${cid}`, customer_name: `C${cid}`,
    customer_phone: '6281', service_name: svc, commission: comm,
  });
  const g = groupRecords([
    rec(1, 7, '2026-10-30', 'Facial', 10000), rec(2, 7, '2026-10-30', 'Peeling', 5000),
    rec(3, 8, '2026-10-30', 'Facial', 10000), rec(4, 7, '2026-10-29', 'Facial', 10000),
  ]);
  assert.equal(g.length, 3); // C7 hari 30, C8 hari 30, C7 hari 29
  assert.equal(g[0].records.length, 2);
  assert.deepEqual(g[0].records.map((r) => r.service_name), ['Facial', 'Peeling']);
  assert.equal(g[0].commission, 15000);
  assert.equal(g[0].rm, 'RM7');
  assert.deepEqual(groupRecords([]), []);
  assert.deepEqual(groupRecords(null), []);
});

// DOM tiruan minimal: cukup untuk memeriksa struktur dan buka-tutup baris customer tanpa browser.
function installFakeDom() {
  class El {
    constructor(tag) { this.tag = tag; this.nodeType = 1; this.attrs = {}; this.children = []; this.listeners = {}; this.style = {}; this.className = ''; this._text = ''; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    append(...k) { this.children.push(...k); }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    click() { (this.listeners.click || []).forEach((f) => f({ target: this })); }
    set innerHTML(v) { this._html = v; }
    get hidden() { return 'hidden' in this.attrs; }
    set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; }
    get classList() {
      const self = this;
      return {
        toggle(c, on) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); (on === undefined ? !s.has(c) : on) ? s.add(c) : s.delete(c); self.className = [...s].join(' '); },
        contains: (c) => self.className.split(/\s+/).includes(c),
      };
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent ?? '').join(''); }
    find(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.find?.(pred, out); return out; }
  }
  globalThis.document = { createElement: (t) => new El(t), createTextNode: (t) => ({ textContent: String(t), nodeType: 3 }) };
}

test('baris customer: awalnya tertutup, klik membuka rincian layanan saja, klik lagi menutup', async () => {
  installFakeDom();
  const { customerGroups, groupRecords } = await import('../public/js/groups.js');
  const rec = (id, svc) => ({ id, customer_id: 7, day: '2026-10-30', created_at: '2026-10-30T03:00:00Z', customer_rm: 'RM7', customer_name: 'Andi', customer_phone: '6281234567890', service_name: svc });
  const open = new Set();
  const root = customerGroups(groupRecords([rec(1, 'Facial'), rec(2, 'Peeling')]), { open, showDay: true });
  const rows = root.find((e) => e.className === 'cgroup__row');
  const detail = root.find((e) => e.className === 'cgroup__detail')[0];
  assert.equal(rows.length, 1); // dua layanan, satu customer -> satu baris
  assert.equal(rows[0].getAttribute('aria-expanded'), 'false');
  assert.equal(detail.hidden, true);
  assert.equal(root.find((e) => e.className === 'svc-item').length, 2);
  // data customer hanya ada di baris induk, bukan di rincian
  assert.ok(rows[0].textContent.includes('Andi') && rows[0].textContent.includes('RM7'));
  assert.ok(!detail.textContent.includes('Andi') && !detail.textContent.includes('RM7'));
  rows[0].click();
  assert.equal(detail.hidden, false);
  assert.equal(rows[0].getAttribute('aria-expanded'), 'true');
  assert.ok(open.has('7|2026-10-30'));
  rows[0].click();
  assert.equal(detail.hidden, true);
  assert.equal(open.size, 0);
  // grup yang dibuka tetap terbuka setelah render ulang (mis. setelah hapus layanan)
  open.add('7|2026-10-30');
  const again = customerGroups(groupRecords([rec(1, 'Facial')]), { open });
  assert.equal(again.find((e) => e.className === 'cgroup__detail')[0].hidden, false);
});
