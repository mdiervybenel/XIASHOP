'use strict';
// XIA SHOP — serveur sans dépendance externe (Node.js 22.13+ : http + node:sqlite)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UP = path.join(DATA, 'uploads');
fs.mkdirSync(UP, { recursive: true });

// ---------- Secret de session et mot de passe administrateur ----------
const secretFile = path.join(DATA, '.secret');
const SECRET = process.env.SESSION_SECRET || (fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8') : (() => { const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, s); return s; })());
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (ADMIN_PASSWORD.length < 8) {
  const pf = path.join(DATA, '.admin-password');
  ADMIN_PASSWORD = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8').trim() : (() => { const p = crypto.randomBytes(6).toString('base64url'); fs.writeFileSync(pf, p); return p; })();
  console.log('\n[XIA SHOP] ADMIN_PASSWORD absent ou trop court. Mot de passe administrateur temporaire : ' + ADMIN_PASSWORD + '\n');
}

// ---------- Base de données ----------
const db = new DatabaseSync(path.join(DATA, 'xiashop.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent TEXT,ord INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,name TEXT NOT NULL,brand TEXT DEFAULT '',cat TEXT,descr TEXT DEFAULT '',price INTEGER DEFAULT 0,promo INTEGER,stock INTEGER,variants TEXT DEFAULT '',status TEXT DEFAULT 'draft',featured INTEGER DEFAULT 0,images TEXT DEFAULT '[]',created INTEGER);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,created INTEGER,name TEXT,phone TEXT,city TEXT,addr TEXT,notes TEXT,lines TEXT,sub INTEGER,fee INTEGER,total INTEGER,status TEXT,vid TEXT,lead_id TEXT);
CREATE TABLE IF NOT EXISTS visitors(vid TEXT PRIMARY KEY,first_seen INTEGER,last_seen INTEGER,sessions INTEGER DEFAULT 0,pageviews INTEGER DEFAULT 0,device TEXT,source TEXT,campaign TEXT,lead_id TEXT,last_path TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER,vid TEXT,sid TEXT,type TEXT,path TEXT,product TEXT,meta TEXT);
CREATE INDEX IF NOT EXISTS ev_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ev_vid ON events(vid);
CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY,created INTEGER,updated INTEGER,name TEXT,phone TEXT UNIQUE,city TEXT,interest TEXT,source TEXT,consent INTEGER DEFAULT 0,status TEXT DEFAULT 'nouveau',notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS survey_responses(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER,vid TEXT,answers TEXT,lead_id TEXT);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER,product TEXT,name TEXT,rating INTEGER,text TEXT,status TEXT DEFAULT 'pending',vid TEXT);`);

const q = (sql) => db.prepare(sql);
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (e) { return d; } };
const getSet = (k, d) => { const r = q('SELECT v FROM settings WHERE k=?').get(k); return r ? J(r.v, d) : d; };
const putSet = (k, v) => q('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));
const nid = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const digits = (s) => String(s || '').replace(/\D/g, '');
const str = (s, n) => String(s == null ? '' : s).trim().slice(0, n || 200);
const int = (v) => (v === '' || v == null || isNaN(+v)) ? null : Math.round(+v);

const DEFAULT_SURVEY = {
  active: true, title: 'Aidez-nous à mieux vous servir', intro: '30 secondes, 4 questions. Merci !',
  questions: [
    { id: 'q1', label: 'Quels produits vous intéressent le plus ?', type: 'multi', options: ['Parfums', 'Beauté & soins', 'Électroménager', 'Autre'] },
    { id: 'q2', label: 'Quel budget dépensez-vous habituellement par achat ?', type: 'choice', options: ['Moins de 10 000 FCFA', '10 000 – 25 000 FCFA', '25 000 – 50 000 FCFA', 'Plus de 50 000 FCFA'] },
    { id: 'q3', label: 'Comment nous avez-vous connus ?', type: 'choice', options: ['WhatsApp', 'Facebook', 'Instagram', 'TikTok', 'Bouche-à-oreille', 'Autre'] },
    { id: 'q4', label: 'Quel produit aimeriez-vous trouver chez XIA SHOP ?', type: 'text' }
  ]
};

// ---------- Catalogue de départ ----------
if (!q('SELECT COUNT(*) n FROM categories').get().n && !q('SELECT COUNT(*) n FROM products').get().n && !getSet('seeded', 0)) {
  const seed = J(fs.readFileSync(path.join(__dirname, 'seed', 'catalog.json'), 'utf8'), null);
  if (seed) {
    const img = (k) => { const f = 'seed-' + k + '.jpg'; fs.copyFileSync(path.join(__dirname, 'seed', 'img', k + '.jpg'), path.join(UP, f)); return '/uploads/' + f; };
    for (const c of seed.c) q('INSERT INTO categories VALUES(?,?,?,?)').run(c.id, c.name, c.parent || null, c.order || 0);
    for (const p of seed.p) q('INSERT INTO products(id,name,brand,cat,descr,price,promo,stock,variants,status,featured,images,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(p.id, p.name, p.brand || '', p.cat, p.desc || '', p.price || 0, p.promo || null, p.stock == null ? null : p.stock, p.variants || '', p.status || 'published', p.featured ? 1 : 0, JSON.stringify(p.images.map(img)), p.created || Date.now());
    putSet('shop', { wa: seed.s.wa, ann: seed.s.ann, pay: seed.s.pay || '', ship: seed.s.ship || [], logo: img('logo'), social: { facebook: '', instagram: '', tiktok: '' } });
    putSet('survey', DEFAULT_SURVEY);
    putSet('seeded', 1);
    console.log('[XIA SHOP] Catalogue de départ importé (' + seed.p.length + ' produits).');
  }
}
if (!getSet('survey', null)) putSet('survey', DEFAULT_SURVEY);

// ---------- Outils HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function send(res, code, body, type, extra) {
  const h = Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' }, extra || {});
  res.writeHead(code, h); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const ok = (res, b) => send(res, 200, b == null ? { ok: true } : b);
const bad = (res, m, c) => send(res, c || 400, { error: m });
function body(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const ch = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('Requête trop volumineuse'), { code: 413 })); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { resolve(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('JSON invalide'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const buckets = new Map();
function limited(req, key, max, winMs) {
  const k = key + '|' + ipOf(req), now = Date.now(); let b = buckets.get(k);
  if (!b || now > b.reset) { b = { n: 0, reset: now + winMs }; buckets.set(k, b); }
  return ++b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

// Session administrateur : jeton signé HMAC dans un cookie HttpOnly
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken() { const exp = Date.now() + 7 * 864e5; const v = 'admin.' + exp; return v + '.' + sign(v); }
function isAdmin(req) {
  const m = /(?:^|;\s*)xs=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return false;
  const t = decodeURIComponent(m[1]), i = t.lastIndexOf('.'); if (i < 0) return false;
  const v = t.slice(0, i), s = t.slice(i + 1), exp = +v.split('.')[1];
  const a = Buffer.from(s), b = Buffer.from(sign(v));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && exp > Date.now();
}
const secure = (req) => (req.headers['x-forwarded-proto'] || '').includes('https');

// ---------- Données publiques ----------
const prodOut = (p) => ({ id: p.id, name: p.name, brand: p.brand, cat: p.cat, desc: p.descr, price: p.price || 0, promo: p.promo, stock: p.stock, variants: p.variants, status: p.status, featured: !!p.featured, images: J(p.images, []), created: p.created });
function catalog(admin) {
  const ps = q(admin ? 'SELECT * FROM products' : "SELECT * FROM products WHERE status IN ('published','unavailable')").all().map(prodOut);
  const pop = {}; q("SELECT product,COUNT(*) n FROM events WHERE type='product' AND ts>? GROUP BY product").all(Date.now() - 30 * 864e5).forEach((r) => { pop[r.product] = r.n; });
  const rv = {}; q("SELECT product,COUNT(*) n,AVG(rating) a FROM reviews WHERE status='approved' GROUP BY product").all().forEach((r) => { rv[r.product] = { n: r.n, avg: Math.round(r.a * 10) / 10 }; });
  ps.forEach((p) => { p.pop = pop[p.id] || 0; p.rating = rv[p.id] || null; });
  const shop = getSet('shop', {}), sv = getSet('survey', DEFAULT_SURVEY);
  return { products: ps, categories: q('SELECT id,name,parent,ord AS "order" FROM categories ORDER BY ord').all().map((c) => Object.assign({}, c)), settings: shop, survey: sv.active ? sv : null };
}

// Rattacher un visiteur à une fiche prospect (par numéro de téléphone)
function upsertLead(o, vid) {
  const phone = digits(o.phone); if (phone.length < 8) return null;
  const now = Date.now(); let l = q('SELECT * FROM leads WHERE phone=?').get(phone);
  if (l) {
    q('UPDATE leads SET updated=?,name=COALESCE(NULLIF(?,\'\'),name),city=COALESCE(NULLIF(?,\'\'),city),interest=COALESCE(NULLIF(?,\'\'),interest),consent=MAX(consent,?) WHERE id=?')
      .run(now, str(o.name, 80), str(o.city, 80), str(o.interest, 200), o.consent ? 1 : 0, l.id);
  } else {
    l = { id: nid('l') }; q('INSERT INTO leads(id,created,updated,name,phone,city,interest,source,consent,status) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(l.id, now, now, str(o.name, 80), phone, str(o.city, 80), str(o.interest, 200), str(o.source, 40), o.consent ? 1 : 0, 'nouveau');
  }
  if (vid) q('UPDATE visitors SET lead_id=? WHERE vid=?').run(l.id, vid);
  return l.id;
}

// ---------- Suivi d'audience (anonyme : aucun IP stocké) ----------
function deviceOf(ua) { ua = String(ua || ''); return /iPad|Tablet/i.test(ua) ? 'Tablette' : /Mobi|Android|iPhone/i.test(ua) ? 'Mobile' : 'Ordinateur'; }
function sourceOf(ref, utm, host) {
  if (utm) return str(utm, 40).toLowerCase();
  let h = ''; try { h = new URL(ref).hostname.replace(/^www\./, ''); } catch (e) { return 'direct'; }
  if (!h || h === host) return 'direct';
  if (/whatsapp|wa\.me/.test(h)) return 'whatsapp';
  if (/facebook|fb\.|messenger/.test(h)) return 'facebook';
  if (/instagram/.test(h)) return 'instagram';
  if (/tiktok/.test(h)) return 'tiktok';
  if (/google/.test(h)) return 'google';
  if (/bing|yahoo|duckduckgo/.test(h)) return 'moteur de recherche';
  return h.slice(0, 40);
}
const TYPES = new Set(['view', 'product', 'cart_add', 'wa_click', 'search', 'order', 'survey', 'lead', 'review']);
function track(req, b) {
  const vid = str(b.vid, 40), sid = str(b.sid, 40); if (!/^[\w-]{8,40}$/.test(vid)) return;
  const now = Date.now(), host = String(req.headers.host || '').split(':')[0].replace(/^www\./, '');
  const v = q('SELECT vid,last_seen FROM visitors WHERE vid=?').get(vid);
  if (!v) q('INSERT INTO visitors(vid,first_seen,last_seen,sessions,pageviews,device,source,campaign) VALUES(?,?,?,?,?,?,?,?)')
    .run(vid, now, now, 1, 0, deviceOf(req.headers['user-agent']), sourceOf(b.ref, b.utm_source, host), str(b.utm_campaign, 60));
  const evs = Array.isArray(b.events) ? b.events.slice(0, 20) : [];
  let pv = 0, newSess = 0, lastPath = null;
  for (const e of evs) {
    if (!TYPES.has(e.type)) continue;
    if (e.type === 'view') { pv++; lastPath = str(e.path, 120); if (e.newSession) newSess = 1; }
    q('INSERT INTO events(ts,vid,sid,type,path,product,meta) VALUES(?,?,?,?,?,?,?)').run(now, vid, sid, e.type, str(e.path, 120), e.product ? str(e.product, 40) : null, e.meta ? str(e.meta, 200) : null);
  }
  if (v) q('UPDATE visitors SET last_seen=?,pageviews=pageviews+?,sessions=sessions+?,last_path=COALESCE(?,last_path) WHERE vid=?').run(now, pv, newSess, lastPath, vid);
  else q('UPDATE visitors SET pageviews=pageviews+?,last_path=? WHERE vid=?').run(pv, lastPath, vid);
}

// ---------- Score des prospects ----------
const SEG = (s, orders) => orders > 0 ? 'Client' : s >= 60 ? 'Chaud' : s >= 30 ? 'Tiède' : 'Froid';
function scoreOf(a) {
  let s = Math.min(a.pv || 0, 20) + Math.min((a.prod || 0) * 2, 30) + Math.min((a.cart || 0) * 8, 24) + Math.min((a.wa || 0) * 10, 20)
    + (a.survey ? 10 : 0) + (a.lead ? 10 : 0) + Math.min((a.orders || 0) * 30, 40);
  const days = (Date.now() - (a.last || 0)) / 864e5; s += days <= 3 ? 10 : days <= 14 ? 5 : 0;
  return Math.min(100, Math.round(s));
}
function engagement(vids) {
  const out = {}; if (!vids.length) return out;
  const ph = vids.map(() => '?').join(',');
  q(`SELECT vid,SUM(type='view') pv,SUM(type='product') prod,SUM(type='cart_add') cart,SUM(type='wa_click') wa,SUM(type='survey') survey,SUM(type='lead') lead,MAX(ts) last FROM events WHERE vid IN (${ph}) GROUP BY vid`).all(...vids).forEach((r) => { out[r.vid] = Object.assign({}, r); });
  return out;
}
function interestsOf(vids) {
  if (!vids.length) return [];
  const ph = vids.map(() => '?').join(','), cats = {};
  const cn = {}; q('SELECT id,name,parent FROM categories').all().forEach((c) => { cn[c.id] = c; });
  q(`SELECT p.cat,COUNT(*) n FROM events e JOIN products p ON p.id=e.product WHERE e.vid IN (${ph}) AND e.type IN ('product','cart_add') GROUP BY p.cat`).all(...vids).forEach((r) => {
    const c = cn[r.cat]; const top = c && c.parent && cn[c.parent] ? cn[c.parent].name : c ? c.name : 'Autre'; cats[top] = (cats[top] || 0) + r.n;
  });
  return Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
}
function leadsList() {
  const leads = q('SELECT * FROM leads ORDER BY updated DESC').all().map((l) => Object.assign({}, l));
  const vmap = {}; q('SELECT vid,lead_id,device,source FROM visitors WHERE lead_id IS NOT NULL').all().forEach((v) => { (vmap[v.lead_id] = vmap[v.lead_id] || []).push(v); });
  const om = {}; q("SELECT lead_id,COUNT(*) n,SUM(total) t,MAX(created) last FROM orders WHERE lead_id IS NOT NULL AND status!='annulee' GROUP BY lead_id").all().forEach((r) => { om[r.lead_id] = r; });
  return leads.map((l) => {
    const vs = vmap[l.id] || [], vids = vs.map((v) => v.vid), en = engagement(vids);
    const a = { pv: 0, prod: 0, cart: 0, wa: 0, survey: 0, lead: 0, last: l.updated };
    Object.values(en).forEach((e) => { a.pv += e.pv; a.prod += e.prod; a.cart += e.cart; a.wa += e.wa; a.survey += e.survey; a.lead += e.lead; a.last = Math.max(a.last, e.last); });
    const o = om[l.id] || { n: 0, t: 0 }; a.orders = o.n;
    if (q('SELECT 1 FROM survey_responses WHERE lead_id=? LIMIT 1').get(l.id)) a.survey = 1;
    const score = scoreOf(a);
    return Object.assign(l, { score, segment: SEG(score, o.n), orders: o.n, spent: o.t || 0, pageviews: a.pv, productViews: a.prod, cartAdds: a.cart, waClicks: a.wa, lastActive: a.last, interests: interestsOf(vids).join(', ') || l.interest || '', source: l.source || (vs[0] && vs[0].source) || '', device: vs[0] ? vs[0].device : '' });
  }).sort((a, b) => b.score - a.score);
}

// ---------- Statistiques ----------
const TZ = 3600e3; // Brazzaville : UTC+1
const dayKey = (ts) => new Date(ts + TZ).toISOString().slice(0, 10);
function stats(days) {
  const now = Date.now(), from = now - days * 864e5, prevFrom = from - days * 864e5;
  const one = (sql, ...a) => (q(sql).get(...a) || {}).n || 0;
  const k = (f, t) => ({
    visitors: one('SELECT COUNT(DISTINCT vid) n FROM events WHERE ts>=? AND ts<?', f, t),
    newVisitors: one('SELECT COUNT(*) n FROM visitors WHERE first_seen>=? AND first_seen<?', f, t),
    pageviews: one("SELECT COUNT(*) n FROM events WHERE type='view' AND ts>=? AND ts<?", f, t),
    productViews: one("SELECT COUNT(*) n FROM events WHERE type='product' AND ts>=? AND ts<?", f, t),
    cartAdds: one("SELECT COUNT(*) n FROM events WHERE type='cart_add' AND ts>=? AND ts<?", f, t),
    waClicks: one("SELECT COUNT(*) n FROM events WHERE type='wa_click' AND ts>=? AND ts<?", f, t),
    orders: one("SELECT COUNT(*) n FROM orders WHERE status!='annulee' AND created>=? AND created<?", f, t),
    revenue: one("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status IN ('confirmee','preparation','expediee','livree') AND created>=? AND created<?", f, t),
    leads: one('SELECT COUNT(*) n FROM leads WHERE created>=? AND created<?', f, t),
    surveys: one('SELECT COUNT(*) n FROM survey_responses WHERE ts>=? AND ts<?', f, t)
  });
  const cur = k(from, now + 1), prev = k(prevFrom, from);
  const series = {}; for (let i = days - 1; i >= 0; i--) series[dayKey(now - i * 864e5)] = { visitors: 0, orders: 0 };
  const vd = {}; q('SELECT vid,ts FROM events WHERE ts>=?').all(from).forEach((r) => { const d = dayKey(r.ts); (vd[d] = vd[d] || new Set()).add(r.vid); });
  Object.keys(vd).forEach((d) => { if (series[d]) series[d].visitors = vd[d].size; });
  q("SELECT created FROM orders WHERE status!='annulee' AND created>=?").all(from).forEach((r) => { const d = dayKey(r.created); if (series[d]) series[d].orders++; });
  const funnelStep = (types) => one(`SELECT COUNT(DISTINCT vid) n FROM events WHERE ts>=? AND type IN (${types.map((t) => "'" + t + "'").join(',')})`, from);
  const funnel = [
    { label: 'Visiteurs', n: cur.visitors },
    { label: 'Ont vu un produit', n: funnelStep(['product']) },
    { label: 'Ont ajouté au panier', n: funnelStep(['cart_add']) },
    { label: 'Ont contacté / commandé', n: funnelStep(['wa_click', 'order']) }
  ];
  const names = {}; q('SELECT id,name FROM products').all().forEach((p) => { names[p.id] = p.name; });
  const topProducts = q(`SELECT product,SUM(type='product') views,SUM(type='cart_add') carts,SUM(type='wa_click') wa FROM events WHERE ts>=? AND product IS NOT NULL GROUP BY product ORDER BY views DESC LIMIT 10`).all(from)
    .map((r) => ({ id: r.product, name: names[r.product] || r.product, views: r.views, carts: r.carts, wa: r.wa }));
  const sources = q('SELECT v.source s,COUNT(DISTINCT v.vid) n FROM visitors v JOIN events e ON e.vid=v.vid WHERE e.ts>=? GROUP BY v.source ORDER BY n DESC LIMIT 8').all(from).map((r) => ({ label: r.s || 'direct', n: r.n }));
  const devices = q('SELECT v.device s,COUNT(DISTINCT v.vid) n FROM visitors v JOIN events e ON e.vid=v.vid WHERE e.ts>=? GROUP BY v.device ORDER BY n DESC').all(from).map((r) => ({ label: r.s, n: r.n }));
  const hours = Array(24).fill(0); q("SELECT ts FROM events WHERE type='view' AND ts>=?").all(from).forEach((r) => { hours[new Date(r.ts + TZ).getUTCHours()]++; });
  const searches = q("SELECT LOWER(meta) s,COUNT(*) n FROM events WHERE type='search' AND ts>=? AND meta IS NOT NULL AND meta!='' GROUP BY LOWER(meta) ORDER BY n DESC LIMIT 10").all(from).map((r) => ({ label: r.s, n: r.n }));
  const live = one('SELECT COUNT(DISTINCT vid) n FROM events WHERE ts>=?', now - 5 * 60e3);
  return { days, kpi: cur, prev, series: Object.entries(series).map(([d, v]) => Object.assign({ day: d }, v)), funnel, topProducts, sources, devices, hours, searches, live };
}
function visitorsList() {
  const now = Date.now(), leads = {}; q('SELECT id,name,phone FROM leads').all().forEach((l) => { leads[l.id] = l; });
  const names = {}; q('SELECT id,name FROM products').all().forEach((p) => { names[p.id] = p.name; });
  const vs = q('SELECT * FROM visitors ORDER BY last_seen DESC LIMIT 200').all().map((v) => Object.assign({}, v));
  const en = engagement(vs.map((v) => v.vid));
  return vs.map((v) => {
    const e = en[v.vid] || {}; const orders = v.lead_id ? one2(v.lead_id) : 0;
    const score = scoreOf({ pv: e.pv, prod: e.prod, cart: e.cart, wa: e.wa, survey: e.survey, lead: e.lead || (v.lead_id ? 1 : 0), orders, last: v.last_seen });
    const lastProd = q("SELECT product FROM events WHERE vid=? AND type='product' ORDER BY ts DESC LIMIT 1").get(v.vid);
    return { vid: v.vid, label: 'Visiteur ' + v.vid.slice(-5).toUpperCase(), firstSeen: v.first_seen, lastSeen: v.last_seen, online: now - v.last_seen < 5 * 60e3, sessions: v.sessions, pageviews: v.pageviews, device: v.device, source: v.source, lead: v.lead_id && leads[v.lead_id] ? { id: v.lead_id, name: leads[v.lead_id].name, phone: leads[v.lead_id].phone } : null, score, segment: SEG(score, orders), cartAdds: e.cart || 0, waClicks: e.wa || 0, lastProduct: lastProd ? names[lastProd.product] || '' : '', lastPath: v.last_path };
  });
}
const one2 = (lead) => (q("SELECT COUNT(*) n FROM orders WHERE lead_id=? AND status!='annulee'").get(lead) || {}).n || 0;
function surveyResults() {
  const sv = getSet('survey', DEFAULT_SURVEY), rs = q('SELECT * FROM survey_responses ORDER BY ts DESC').all();
  const leads = {}; q('SELECT id,name,phone FROM leads').all().forEach((l) => { leads[l.id] = l; });
  const res = sv.questions.map((qq) => {
    const out = { id: qq.id, label: qq.label, type: qq.type, counts: {}, texts: [] };
    (qq.options || []).forEach((o) => { out.counts[o] = 0; });
    rs.forEach((r) => { const a = J(r.answers, {})[qq.id]; if (a == null || a === '') return;
      if (qq.type === 'text') out.texts.push({ ts: r.ts, text: String(a) });
      else (Array.isArray(a) ? a : [a]).forEach((x) => { out.counts[x] = (out.counts[x] || 0) + 1; }); });
    return out;
  });
  return { survey: sv, total: rs.length, results: res, recent: rs.slice(0, 50).map((r) => ({ ts: r.ts, answers: J(r.answers, {}), lead: r.lead_id && leads[r.lead_id] ? leads[r.lead_id] : null })) };
}
const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };

// ---------- Images (envoyées en base64 par l'administration, déjà redimensionnées) ----------
function saveImage(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('Image invalide (JPEG, PNG ou WebP)'), { code: 400 });
  const buf = Buffer.from(m[2], 'base64'); if (buf.length > 4 * 1024 * 1024) throw Object.assign(new Error('Image trop lourde (4 Mo max)'), { code: 413 });
  const f = crypto.randomBytes(10).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UP, f), buf); return '/uploads/' + f;
}

// ---------- Routeur ----------
const ORDER_ST = ['nouvelle', 'en_attente', 'confirmee', 'preparation', 'expediee', 'livree', 'annulee'];
const LEAD_ST = ['nouveau', 'contacte', 'interesse', 'client', 'perdu'];
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  // ---- Public ----
  if (p === '/api/catalog' && m === 'GET') return ok(res, catalog(false));
  if (p === '/api/track' && m === 'POST') { if (limited(req, 'tr', 240, 60e3)) return ok(res); track(req, await body(req, 20e3)); return ok(res); }
  if (p === '/api/reviews' && m === 'GET') return ok(res, q("SELECT id,ts,name,rating,text FROM reviews WHERE product=? AND status='approved' ORDER BY ts DESC LIMIT 50").all(str(url.searchParams.get('product'), 40)).map((r) => Object.assign({}, r)));
  if (p === '/api/reviews' && m === 'POST') {
    if (limited(req, 'rv', 5, 3600e3)) return bad(res, 'Trop d\'avis envoyés, réessayez plus tard', 429);
    const b = await body(req, 10e3), r = int(b.rating), prod = q('SELECT id FROM products WHERE id=?').get(str(b.product, 40));
    if (!prod || !(r >= 1 && r <= 5) || str(b.name, 60).length < 2 || str(b.text, 1000).length < 3) return bad(res, 'Avis incomplet');
    q('INSERT INTO reviews(ts,product,name,rating,text,status,vid) VALUES(?,?,?,?,?,?,?)').run(Date.now(), prod.id, str(b.name, 60), r, str(b.text, 1000), 'pending', str(b.vid, 40));
    return ok(res);
  }
  if (p === '/api/survey' && m === 'POST') {
    if (limited(req, 'sv', 5, 3600e3)) return bad(res, 'Trop de réponses, réessayez plus tard', 429);
    const b = await body(req, 20e3), sv = getSet('survey', DEFAULT_SURVEY), ans = {};
    for (const qq of sv.questions) { const a = b.answers && b.answers[qq.id]; if (a == null) continue;
      if (qq.type === 'text') ans[qq.id] = str(a, 500);
      else if (qq.type === 'multi') ans[qq.id] = (Array.isArray(a) ? a : [a]).map((x) => str(x, 100)).filter((x) => (qq.options || []).includes(x));
      else if ((qq.options || []).includes(a)) ans[qq.id] = a; }
    if (!Object.keys(ans).length) return bad(res, 'Merci de répondre à au moins une question');
    const lead = b.contact && b.contact.consent ? upsertLead({ name: b.contact.name, phone: b.contact.phone, city: b.contact.city, consent: 1, source: 'sondage' }, str(b.vid, 40)) : null;
    q('INSERT INTO survey_responses(ts,vid,answers,lead_id) VALUES(?,?,?,?)').run(Date.now(), str(b.vid, 40), JSON.stringify(ans), lead);
    return ok(res);
  }
  if (p === '/api/lead' && m === 'POST') {
    if (limited(req, 'ld', 5, 3600e3)) return bad(res, 'Trop de demandes, réessayez plus tard', 429);
    const b = await body(req, 10e3); if (!b.consent) return bad(res, 'Merci d\'accepter d\'être recontacté');
    const id = upsertLead({ name: b.name, phone: b.phone, city: b.city, interest: b.interest, consent: 1, source: str(b.source, 40) || 'formulaire' }, str(b.vid, 40));
    return id ? ok(res) : bad(res, 'Numéro de téléphone invalide');
  }
  if (p === '/api/orders' && m === 'POST') {
    if (limited(req, 'od', 10, 3600e3)) return bad(res, 'Trop de commandes, réessayez plus tard', 429);
    const b = await body(req, 30e3), shop = getSet('shop', {});
    if (str(b.name, 80).length < 2 || digits(b.phone).length < 8 || !str(b.city) || !str(b.addr)) return bad(res, 'Informations de commande incomplètes');
    const lines = []; let sub = 0;
    for (const l of (Array.isArray(b.lines) ? b.lines.slice(0, 50) : [])) {
      const pr = q('SELECT * FROM products WHERE id=?').get(str(l.id, 40)); if (!pr) continue;
      const qn = Math.max(1, Math.min(999, int(l.q) || 1)), price = pr.price > 0 ? (pr.promo > 0 && pr.promo < pr.price ? pr.promo : pr.price) : null;
      if (price) sub += price * qn; lines.push({ id: pr.id, name: pr.name, v: str(l.v, 80), q: qn, price });
    }
    if (!lines.length) return bad(res, 'Panier vide');
    const z = (shop.ship || [])[int(b.zone)], fee = z ? +z.fee || 0 : null, vid = str(b.vid, 40);
    const lead = upsertLead({ name: b.name, phone: b.phone, city: b.city, consent: b.consent ? 1 : 0, source: 'commande' }, vid);
    const id = 'XIA-' + dayKey(Date.now()).slice(2).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    q('INSERT INTO orders(id,created,name,phone,city,addr,notes,lines,sub,fee,total,status,vid,lead_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, Date.now(), str(b.name, 80), digits(b.phone), str(b.city, 80), str(b.addr, 200), str(b.notes, 500), JSON.stringify(lines), sub, fee, sub + (fee || 0), 'en_attente', vid, lead);
    return ok(res, { id, sub, fee, total: sub + (fee || 0), zone: z ? z.zone : null });
  }
  // ---- Administration ----
  if (p === '/api/admin/login' && m === 'POST') {
    if (limited(req, 'lg', 10, 15 * 60e3)) return bad(res, 'Trop de tentatives, réessayez dans 15 minutes', 429);
    const b = await body(req, 2e3), a = crypto.createHash('sha256').update(String(b.password || '')).digest(), e = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
    if (!crypto.timingSafeEqual(a, e)) return bad(res, 'Mot de passe incorrect', 401);
    return send(res, 200, { ok: true }, null, { 'Set-Cookie': 'xs=' + makeToken() + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800' + (secure(req) ? '; Secure' : '') });
  }
  if (p === '/api/admin/logout') return send(res, 200, { ok: true }, null, { 'Set-Cookie': 'xs=; Path=/; Max-Age=0' });
  if (!p.startsWith('/api/admin/')) return bad(res, 'Introuvable', 404);
  if (!isAdmin(req)) return bad(res, 'Connexion requise', 401);
  const r = p.slice(11), seg = r.split('/');
  if (r === 'me') return ok(res, { ok: true });
  if (r === 'catalog' && m === 'GET') return ok(res, catalog(true));
  if (r === 'stats' && m === 'GET') return ok(res, stats(Math.max(1, Math.min(365, int(url.searchParams.get('days')) || 30))));
  if (r === 'visitors' && m === 'GET') return ok(res, visitorsList());
  if (seg[0] === 'visitors' && seg[1] && m === 'GET') {
    const names = {}; q('SELECT id,name FROM products').all().forEach((x) => { names[x.id] = x.name; });
    return ok(res, q('SELECT ts,type,path,product,meta FROM events WHERE vid=? ORDER BY ts DESC LIMIT 100').all(str(seg[1], 40)).map((e) => Object.assign({}, e, { productName: e.product ? names[e.product] || '' : '' })));
  }
  if (r === 'leads' && m === 'GET') return ok(res, leadsList());
  if (r === 'leads.csv' && m === 'GET') {
    const L = leadsList(), cols = [['name', 'Nom'], ['phone', 'Téléphone'], ['city', 'Ville / quartier'], ['segment', 'Segment'], ['score', 'Score'], ['status', 'Statut'], ['orders', 'Commandes'], ['spent', 'Total dépensé (FCFA)'], ['interests', 'Intérêts'], ['source', 'Source'], ['consent', 'Accepte d\'être recontacté'], ['notes', 'Notes'], ['created', 'Créé le'], ['lastActive', 'Dernière activité']];
    const fmtD = (t) => t ? new Date(t + TZ).toISOString().slice(0, 16).replace('T', ' ') : '';
    const csv = '﻿' + cols.map((c) => csvCell(c[1])).join(';') + '\n' + L.map((l) => cols.map((c) => csvCell(c[0] === 'created' || c[0] === 'lastActive' ? fmtD(l[c[0]]) : c[0] === 'consent' ? (l.consent ? 'oui' : 'non') : l[c[0]])).join(';')).join('\n');
    return send(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="xiashop-prospects.csv"' });
  }
  if (r === 'leads' && m === 'POST') { const b = await body(req, 10e3); const id = upsertLead({ name: b.name, phone: b.phone, city: b.city, interest: b.interest, consent: b.consent ? 1 : 0, source: str(b.source, 40) || 'ajout manuel' }, null); return id ? ok(res, { id }) : bad(res, 'Numéro de téléphone invalide'); }
  if (seg[0] === 'leads' && seg[1] && m === 'PATCH') {
    const b = await body(req, 10e3), l = q('SELECT * FROM leads WHERE id=?').get(seg[1]); if (!l) return bad(res, 'Prospect introuvable', 404);
    q('UPDATE leads SET status=?,notes=?,name=?,city=?,interest=?,updated=? WHERE id=?').run(LEAD_ST.includes(b.status) ? b.status : l.status, b.notes != null ? str(b.notes, 2000) : l.notes, b.name != null ? str(b.name, 80) : l.name, b.city != null ? str(b.city, 80) : l.city, b.interest != null ? str(b.interest, 200) : l.interest, Date.now(), l.id);
    return ok(res);
  }
  if (seg[0] === 'leads' && seg[1] && m === 'DELETE') { q('UPDATE visitors SET lead_id=NULL WHERE lead_id=?').run(seg[1]); q('UPDATE orders SET lead_id=NULL WHERE lead_id=?').run(seg[1]); q('UPDATE survey_responses SET lead_id=NULL WHERE lead_id=?').run(seg[1]); q('DELETE FROM leads WHERE id=?').run(seg[1]); return ok(res); }
  if (r === 'orders' && m === 'GET') return ok(res, q('SELECT * FROM orders ORDER BY created DESC LIMIT 500').all().map((o) => Object.assign({}, o, { lines: J(o.lines, []) })));
  if (seg[0] === 'orders' && seg[1] && m === 'PATCH') { const b = await body(req, 2e3); if (!ORDER_ST.includes(b.status)) return bad(res, 'Statut invalide'); q('UPDATE orders SET status=? WHERE id=?').run(b.status, seg[1]); return ok(res); }
  if (r === 'upload' && m === 'POST') { const b = await body(req, 7e6); return ok(res, { url: saveImage(b.data) }); }
  if (seg[0] === 'products' && (m === 'POST' || m === 'PUT')) {
    const b = await body(req, 50e3), id = m === 'POST' ? nid('p') : str(seg[1], 40), old = q('SELECT * FROM products WHERE id=?').get(id);
    if (m === 'PUT' && !old) return bad(res, 'Produit introuvable', 404);
    const price = int(b.price), promo = int(b.promo), stock = int(b.stock);
    if (str(b.name, 160).length < 2) return bad(res, 'Le nom est obligatoire');
    if (!(price >= 0)) return bad(res, 'Prix de vente invalide');
    if (promo != null && !(promo > 0 && promo < price)) return bad(res, 'Le prix promo doit être inférieur au prix de vente');
    if (stock != null && stock < 0) return bad(res, 'Stock invalide');
    if (!q('SELECT 1 FROM categories WHERE id=?').get(str(b.cat, 40))) return bad(res, 'Choisissez une catégorie');
    const imgs = (Array.isArray(b.images) ? b.images : []).map((x) => str(x, 200)).filter((x) => /^\/uploads\/[\w.-]+$/.test(x)).slice(0, 10);
    const st = ['draft', 'published', 'unavailable'].includes(b.status) ? b.status : 'draft';
    q('INSERT INTO products(id,name,brand,cat,descr,price,promo,stock,variants,status,featured,images,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,brand=excluded.brand,cat=excluded.cat,descr=excluded.descr,price=excluded.price,promo=excluded.promo,stock=excluded.stock,variants=excluded.variants,status=excluded.status,featured=excluded.featured,images=excluded.images')
      .run(id, str(b.name, 160), str(b.brand, 80), str(b.cat, 40), str(b.desc, 4000), price, promo, stock, str(b.variants, 400), st, b.featured ? 1 : 0, JSON.stringify(imgs), old ? old.created : Date.now());
    return ok(res, { id });
  }
  if (seg[0] === 'products' && seg[1] && m === 'PATCH') { const b = await body(req, 2e3); if (!['draft', 'published', 'unavailable'].includes(b.status)) return bad(res, 'Statut invalide'); q('UPDATE products SET status=? WHERE id=?').run(b.status, seg[1]); return ok(res); }
  if (seg[0] === 'products' && seg[1] && m === 'DELETE') { q('DELETE FROM products WHERE id=?').run(seg[1]); return ok(res); }
  if (seg[0] === 'categories' && m === 'POST') { const b = await body(req, 2e3); if (!str(b.name, 60)) return bad(res, 'Nom requis'); const par = b.parent && q('SELECT 1 FROM categories WHERE id=? AND parent IS NULL').get(b.parent) ? b.parent : null; const id = nid('c'); q('INSERT INTO categories VALUES(?,?,?,?)').run(id, str(b.name, 60), par, (q('SELECT MAX(ord) n FROM categories').get().n || 0) + 1); return ok(res, { id }); }
  if (seg[0] === 'categories' && seg[1] && m === 'PATCH') { const b = await body(req, 2e3); if (!str(b.name, 60)) return bad(res, 'Nom requis'); q('UPDATE categories SET name=? WHERE id=?').run(str(b.name, 60), seg[1]); return ok(res); }
  if (seg[0] === 'categories' && seg[1] && m === 'DELETE') {
    if (q('SELECT 1 FROM products WHERE cat=?').get(seg[1]) || q('SELECT 1 FROM categories WHERE parent=?').get(seg[1])) return bad(res, 'Catégorie non vide : déplacez d\'abord ses produits');
    q('DELETE FROM categories WHERE id=?').run(seg[1]); return ok(res);
  }
  if (r === 'settings' && m === 'PUT') {
    const b = await body(req, 30e3), old = getSet('shop', {});
    const ship = (Array.isArray(b.ship) ? b.ship : []).slice(0, 40).map((z) => ({ zone: str(z.zone, 80), fee: Math.max(0, int(z.fee) || 0), delay: str(z.delay, 60) })).filter((z) => z.zone);
    const logo = typeof b.logo === 'string' && /^\/uploads\/[\w.-]+$/.test(b.logo) ? b.logo : old.logo;
    const so = b.social || {}, url2 = (u) => /^https:\/\/[^\s"<>]+$/.test(str(u, 200)) ? str(u, 200) : '';
    putSet('shop', { wa: digits(b.wa) || old.wa, ann: str(b.ann, 200), pay: str(b.pay, 600), ship, logo, social: { facebook: url2(so.facebook), instagram: url2(so.instagram), tiktok: url2(so.tiktok) }, pages: { livraison: str((b.pages || {}).livraison, 4000), cgv: str((b.pages || {}).cgv, 8000), confid: str((b.pages || {}).confid, 8000) } });
    return ok(res);
  }
  if (r === 'survey' && m === 'GET') return ok(res, surveyResults());
  if (r === 'survey' && m === 'PUT') {
    const b = await body(req, 30e3);
    const qs = (Array.isArray(b.questions) ? b.questions : []).slice(0, 12).map((x, i) => ({ id: /^[\w-]{1,20}$/.test(x.id) ? x.id : 'q' + Date.now().toString(36) + i, label: str(x.label, 200), type: ['choice', 'multi', 'text'].includes(x.type) ? x.type : 'choice', options: x.type === 'text' ? [] : (Array.isArray(x.options) ? x.options : []).map((o) => str(o, 100)).filter(Boolean).slice(0, 12) })).filter((x) => x.label && (x.type === 'text' || x.options.length >= 2));
    if (!qs.length) return bad(res, 'Ajoutez au moins une question complète (2 choix minimum)');
    putSet('survey', { active: !!b.active, title: str(b.title, 120) || 'Sondage', intro: str(b.intro, 300), questions: qs });
    return ok(res);
  }
  if (r === 'reviews' && m === 'GET') { const names = {}; q('SELECT id,name FROM products').all().forEach((x) => { names[x.id] = x.name; }); return ok(res, q('SELECT * FROM reviews ORDER BY ts DESC LIMIT 300').all().map((x) => Object.assign({}, x, { productName: names[x.product] || '' }))); }
  if (seg[0] === 'reviews' && seg[1] && m === 'PATCH') { const b = await body(req, 2e3); if (!['pending', 'approved', 'rejected'].includes(b.status)) return bad(res, 'Statut invalide'); q('UPDATE reviews SET status=? WHERE id=?').run(b.status, int(seg[1])); return ok(res); }
  if (seg[0] === 'reviews' && seg[1] && m === 'DELETE') { q('DELETE FROM reviews WHERE id=?').run(int(seg[1])); return ok(res); }
  return bad(res, 'Introuvable', 404);
}

function serveFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache || 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}

const PUB = path.join(__dirname, 'public');
http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, 'Requête invalide', 'text/plain'); }
  const p = decodeURIComponent(url.pathname);
  try {
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (p.startsWith('/uploads/')) { const f = path.join(UP, path.basename(p)); return serveFile(res, f, 'public, max-age=2592000, immutable'); }
    if (p === '/admin' || p === '/admin/') return serveFile(res, path.join(PUB, 'admin.html'));
    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
    const f = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (f.startsWith(PUB) && p !== '/' && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(res, f, 'public, max-age=3600');
    return serveFile(res, path.join(PUB, 'index.html'));
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') console.error(e);
    if (!res.headersSent) bad(res, typeof e.code === 'number' ? e.message : 'Erreur serveur', typeof e.code === 'number' ? e.code : 500);
  }
}).listen(PORT, () => console.log('[XIA SHOP] En ligne sur le port ' + PORT));
