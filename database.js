/* ================================================================
   SIUJIAN — database.js
   Lapisan Database · Sistem Ujian Terpadu (persisten + realtime)
   ----------------------------------------------------------------
   Engine : localStorage (data tidak hilang walau browser ditutup)
            + BroadcastChannel (sinkronisasi realtime antar-tab)
   Versi  : 2 (data lama versi 2 tetap terbaca, tidak ter-reset)

   SKEMA — 9 TABEL RELASIONAL
   ┌───────────┬────────────────────────────────────────────────────┐
   │ monitors  │ akun pemantau (username, salt, hash password)      │
   │ students  │ peserta (key unik = nama|kelas, nomor ujian)       │
   │ exams     │ header ujian (mapel, guru, durasi, aturan)         │
   │ questions │ bank soal PG (examId, order, opts, answer)         │
   │ sessions  │ sesi per peserta (working|submitted|banned)        │
   │ answers   │ jawaban per soal (sessionId + questionId, upsert)  │
   │ warnings  │ pelanggaran/alarm (type EXIT = diskualifikasi)     │
   │ activity  │ log aktivitas ujian (timestamp server)             │
   │ audit     │ audit log pemantau (append-only + rantai hash)     │
   └───────────┴────────────────────────────────────────────────────┘

   RELASI:
     questions.examId   → exams.id
     sessions.studentId → students.id
     sessions.examId    → exams.id
     answers.sessionId  → sessions.id
     answers.questionId → questions.id
     warnings.sessionId → sessions.id
     activity.sessionId → sessions.id
================================================================ */
(function(){
'use strict';

/* ================================================================
   1. UTILITAS HASH (ber-salt)
   cyrb53 — hash 64-bit cepat untuk password & rantai audit.
   Catatan produksi: ganti dengan bcrypt/argon2 di sisi server.
================================================================ */
function H(str, seed = 7){
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for(let i = 0; i < str.length; i++){
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
function salt(){
  return Math.random().toString(36).slice(2, 10);
}

/* ================================================================
   2. KONFIGURASI
================================================================ */
const KEY     = 'SIUJIAN_DB_V2';   // kunci penyimpanan
const VERSION = 2;                 // naikkan jika skema berubah
const TABLES  = ['monitors','students','exams','questions','sessions',
                 'answers','warnings','activity','audit'];
const PREFIX  = { monitors:'MON', students:'STU', exams:'EXM', questions:'QES',
                  sessions:'SES', answers:'ANS', warnings:'WRN',
                  activity:'ACT', audit:'AUD' };

/* ================================================================
   3. STATE INTERNAL
================================================================ */
let data      = null;   // seluruh isi database
let lastWrite = null;   // jam sinkronisasi terakhir
let online    = true;   // status penyimpanan (false = gagal tulis)

/* ================================================================
   4. SEED DATA AWAL (hanya saat database belum ada / versi beda)
================================================================ */
function blank(){
  const d = { __v: VERSION, seq: {} };
  TABLES.forEach(t => d[t] = []);
  return d;
}
function seed(){
  data = blank();

  /* akun pemantau default — password: sekolah2024 */
  const s = salt();
  data.monitors.push({
    id:'MON-0001', createdAt: Date.now(),
    username:'monitor01', name:'Pemantau 01',
    salt: s, hash: H(s + 'sekolah2024')
  });

  /* header ujian */
  data.exams.push({
    id:'EXM-0001', createdAt: Date.now(),
    title:'Ujian Sekolah — Matematika', subject:'Matematika',
    teacher:'Drs. Hendra Wijaya, M.Pd', semester:'Genap',
    durationSec: 900, status:'AKTIF',
    rule:'KELUAR HALAMAN = DISKUALIFIKASI OTOMATIS'
  });

  /* bank soal — 10 pilihan ganda */
  const Q = [
    ['Hasil dari 15 + 27 × 2 adalah …',                    ['84','69','72','54'],              1],
    ['KPK dari 12 dan 18 adalah …',                        ['24','36','48','72'],              1],
    ['0,25 + ½ = …',                                       ['0,50','0,75','0,30','1,00'],      1],
    ['Jika 3x = 27, maka nilai x adalah …',                ['3','6','9','24'],                 2],
    ['Luas persegi panjang p = 12 cm dan l = 7 cm adalah …',['19 cm²','38 cm²','76 cm²','84 cm²'],3],
    ['35% dari 200 adalah …',                              ['35','60','70','75'],              2],
    ['Suhu −3°C naik 8°C. Suhu sekarang menjadi …',        ['−11°C','5°C','11°C','−5°C'],      1],
    ['Median dari data 4, 7, 9, 10, 15 adalah …',          ['4','7','9','10'],                 2],
    ['Gradien garis y = 2x + 5 adalah …',                  ['2','5','2x','x'],                 0],
    ['2³ × 2² = …',                                        ['4','32','64','16'],               1]
  ];
  Q.forEach((q, i) => data.questions.push({
    id:'QES-' + String(i + 1).padStart(2, '0'), createdAt: Date.now(),
    examId:'EXM-0001', order: i + 1,
    text: q[0], opts: q[1], answer: q[2]
  }));

  flush();
}

/* ================================================================
   5. PENYIMPANAN (flush / load)
================================================================ */
function flush(){
  try{
    localStorage.setItem(KEY, JSON.stringify(data));
    lastWrite = Date.now();
    online = true;
  }catch(e){
    online = false;
    console.error('[DB] Gagal menyimpan ke penyimpanan:', e);
  }
}
function load(){
  try{ data = JSON.parse(localStorage.getItem(KEY)); }catch(e){ data = null; }
  if(!data || data.__v !== VERSION) seed();
}

/* ================================================================
   6. REALTIME BUS — sinkronisasi antar-tab (produksi → SSE/WS)
================================================================ */
const RT    = ('BroadcastChannel' in window) ? new BroadcastChannel('SIUJIAN_RT') : null;
const MY_ID = H(String(Math.random()));
if(RT) RT.onmessage = e => {
  if(typeof window.handleRT === 'function') window.handleRT(e.data);
};
function rt(type, payload){
  if(RT) RT.postMessage({ type, payload, at: Date.now(), src: MY_ID });
}

/* ================================================================
   7. CRUD INTI
================================================================ */
function one(table, query){
  return data[table].find(r => Object.keys(query || {}).every(k => r[k] === query[k])) || null;
}
function find(table, query){
  return data[table].filter(r => Object.keys(query || {}).every(k => r[k] === query[k]));
}
function insert(table, row){
  data.seq[table] = (data.seq[table] || 0) + 1;
  row.id = PREFIX[table] + '-' + String(data.seq[table]).padStart(4, '0');
  row.createdAt = Date.now();
  data[table].push(row);
  flush();
  rt('DB_WRITE', { table, id: row.id });   // beri tahu tab lain
  return row;
}
function update(table, id, patch){
  const row = data[table].find(x => x.id === id);
  if(row){ Object.assign(row, patch); flush(); rt('DB_WRITE', { table, id }); }
  return row || null;
}

/* ================================================================
   8. AUDIT — append-only dengan rantai hash (tamper-evident)
================================================================ */
function auditAppend(actor, action, obj){
  const rows = data.audit;
  const prev = rows.length ? rows[rows.length - 1].hash : 'GENESIS';
  const at   = Date.now();
  return insert('audit', {
    at, actor,
    action: action || '—',
    obj:    obj    || '—',
    prev,
    hash: H(prev + '|' + at + '|' + actor + '|' + (action || '') + '|' + (obj || ''))
  });
}
function verifyAuditChain(){
  for(const a of data.audit){
    const expect = H(a.prev + '|' + a.at + '|' + a.actor + '|' + a.action + '|' + a.obj);
    if(a.hash !== expect) return { valid: false, brokenAt: a.id };
  }
  return { valid: true, count: data.audit.length };
}

/* ================================================================
   9. STATISTIK & BACKUP (API pengembang — dipakai lewat Console,
      bukan tombol di UI)
================================================================ */
function rows(){
  return TABLES.reduce((n, t) => n + data[t].length, 0);
}
function sizeKB(){
  try{ return Math.round(JSON.stringify(data).length / 1024); }catch(e){ return 0; }
}
function exportJSON(){            // DB.exportJSON() di console
  return JSON.stringify(data, null, 2);
}
function importJSON(json){        // DB.importJSON('...') di console
  const d = JSON.parse(json);
  if(!d.__v || !d.students) throw new Error('Bukan berkas database SIUJIAN.');
  data = d;
  flush();
}

/* ================================================================
   10. API PUBLIK — dipakai oleh siujian.html
================================================================ */
window.H     = H;
window.salt  = salt;
window.rt    = rt;
window.MY_ID = MY_ID;
window.DB = {
  KEY, VERSION,
  load,
  online:    () => online,
  lastWrite: () => lastWrite,
  one, find,
  raw:    t => data[t],
  insert, update,
  answersOf: sid => data.answers.filter(a => a.sessionId === sid),
  exam:      () => data.exams[0],
  qsOf:      examId => data.questions
                 .filter(q => q.examId === examId)
                 .sort((a, b) => a.order - b.order),
  auditAppend, verifyAuditChain,
  rows, sizeKB, exportJSON, importJSON,
  reset(){ localStorage.removeItem(KEY); location.reload(); }
};

})();
