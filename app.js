// Lending Library — staff tool for the Housing Lending Library.
// Data lives in Firebase (Firestore). With no Firebase config, it runs in demo mode with sample data.
import { CONFIG } from "./config.js";

const DEMO = !(CONFIG.firebase && CONFIG.firebase.apiKey);
const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const DAY = 864e5, MIN = 60e3;

const DEFAULT_PUDOS = [
  { id: "TSO", building: "Krupp A–D", room: "TSO", active: true },
  { id: "B28", building: "Krupp E–F", room: "Basement 28", active: false },
  { id: "MD-101", building: "Mercator", room: "MD-101", active: true },
  { id: "XD-244", building: "College 3", room: "XD-244", active: true },
  { id: "NC-215", building: "Nordmetall", room: "NC-215", active: true },
];
const DEFAULT_SETTINGS = {
  pudos: DEFAULT_PUDOS,
  itemLimit: 2,             // Rule 5: items reserved or held at once
  loanDays: 2,              // Rule 4: loan period
  extensionDays: 2,         // Rule 4: one extension of up to 2 days
  noShowWaitMinutes: 15,    // Process step 5
  noShowLimit: 3,           // Rule 17
  suspensionDays: 90,       // Rule 17: 3 months
  lateFeePerDay: 5,         // Rule 13
  contactAttempts: 4,       // Step 7: escalate after 4–5 attempts
  advanceRule: "warn",      // "warn": SAs may book same-day with a reason; "strict": only supervisors
  retentionMonths: 12,
  notifyEmail: "",          // reminders + morning summary (Housing mailbox)
  escalationEmail: "",      // escalations + suspensions (Housing Team); empty = notifyEmail
  emailReminders: true,
  teamsReminders: true,
};

// ---------------- helpers ----------------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : String(k));
  }
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (["value", "checked", "disabled", "selected", "required", "hidden"].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  return el;
}
const pad = (n) => String(n).padStart(2, "0");
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const ts = (iso) => new Date(iso).getTime();
const fmtTime = (iso) => { const d = new Date(iso); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const fmtDay = (iso) => { const d = new Date(iso); return WD[d.getDay()] + " " + d.getDate() + " " + MON[d.getMonth()]; };
const fmtFull = (iso) => fmtDay(iso) + " · " + fmtTime(iso);
const fmtDate = (iso) => { const d = new Date(iso); return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear(); };
const toInput = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d; }; // calendar days, safe across clock changes
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function rel(iso) {
  const ms = ts(iso) - Date.now(), a = Math.abs(ms);
  let t;
  if (a < 3600e3) t = Math.max(1, Math.round(a / MIN)) + " min";
  else if (a < DAY) t = Math.round(a / 3600e3) + " h";
  else { const n = Math.round(a / DAY); t = n + " day" + (n === 1 ? "" : "s"); }
  return ms >= 0 ? "in " + t : t + " ago";
}
const nowIso = () => new Date().toISOString();
const norm = (s) => (s === undefined || s === null ? "" : String(s)).trim();
const lc = (s) => norm(s).toLowerCase();
const euro = (n) => "€" + (Math.round(n * 100) / 100).toFixed(n % 1 ? 2 : 0);

// ---------------- state ----------------
const S = {
  user: null, me: null,
  staff: [], settings: { ...DEFAULT_SETTINGS }, items: [], borrowers: [], loans: [],
  loaded: { items: false, loans: false, borrowers: false },
  view: "today", armed: null,
  q: { loans: "", items: "", borrowers: "" },
  loanFilter: "active", itemFilter: "all", itemPudo: "all",
  calMonth: null, calDay: null, logTab: "noshows",
};
const isSup = () => !!(S.me && S.me.role === "supervisor");
const meRef = () => ({ email: S.user.email, name: (S.me && S.me.name) || S.user.email });
const liveLoans = () => S.loans.filter((l) => !l.deleted);
const borrowerOf = (matric) => S.borrowers.find((b) => b.id === matric);
const itemById = (id) => S.items.find((i) => i.id === id);
const pudos = () => (S.settings.pudos && S.settings.pudos.length ? S.settings.pudos : DEFAULT_PUDOS);
const pudoById = (id) => pudos().find((p) => p.id === id);
const pudoLabel = (id) => { const p = pudoById(id); return p ? p.room + " (" + p.building + ")" : id || "—"; };
const pudoShort = (id) => { const p = pudoById(id); return p ? p.room : id || "—"; };
const itemLabel = (it) => it.name + (it.tag ? " " + it.tag : "");

// ---------------- rules ----------------
const isOpen = (l) => l.status === "booked" || l.status === "out";
function loanState(l) {
  const now = Date.now();
  if (l.status === "booked") return now > ts(l.pickupAt) + S.settings.noShowWaitMinutes * MIN ? "missed" : "booked";
  if (l.status === "out") return now > ts(l.returnAt) ? "overdue" : "out";
  return l.status;
}
const LOAN_LABEL = { booked: "Booked", missed: "Didn't show up?", out: "Out", overdue: "Overdue", returned: "Returned", noshow: "No-show", cancelled: "Cancelled", notreturned: "Not returned" };

function itemState(it) {
  if (it.condition === "broken" || it.condition === "missing") return { kind: it.condition };
  const ls = liveLoans().filter((l) => isOpen(l) && (l.itemIds || []).includes(it.id));
  const out = ls.find((l) => l.status === "out");
  if (out) return { kind: loanState(out) === "overdue" ? "overdue" : "out", loan: out };
  const next = ls.sort((a, b) => ts(a.pickupAt) - ts(b.pickupAt))[0];
  if (next) return { kind: "ready", loan: next };
  return { kind: "ready" };
}
const ITEM_LABEL = { ready: "On the shelf", out: "Lent out", overdue: "Overdue", broken: "Broken", missing: "Missing" };

function itemClash(itemId, a, b, ignoreLoanId) {
  return liveLoans().find((l) => {
    if (l.id === ignoreLoanId || !isOpen(l) || !(l.itemIds || []).includes(itemId)) return false;
    const start = ts(l.pickupAt);
    const end = l.status === "out" ? Math.max(ts(l.returnAt), Date.now()) : ts(l.returnAt);
    return start < b && end > a;
  }) || null;
}
// Rule 5: items reserved or currently held by this student
function heldItems(matric, ignoreLoanId) {
  return liveLoans().filter((l) => l.matric === matric && isOpen(l) && l.id !== ignoreLoanId)
    .reduce((n, l) => n + (l.itemIds || []).length, 0);
}
// Rule 3: pickup must be on a later calendar day than the booking
const advanceOk = (pickupMs, bookedMs = Date.now()) => startOfDay(pickupMs) > startOfDay(bookedMs);

function currentSuspension(b) {
  const now = Date.now();
  return ((b && b.suspensions) || []).find((s) => !s.liftedAt && (!s.until || ts(s.until) > now)) || null;
}
// No-shows that count toward the next automatic suspension (those after the last automatic one)
function countingNoShows(b) {
  const last = ((b && b.suspensions) || []).filter((s) => s.auto).map((s) => ts(s.from)).sort((x, y) => y - x)[0] || 0;
  return ((b && b.noShows) || []).filter((n) => ts(n.at) > last);
}
function borrowerState(b) {
  if (!b) return { kind: "new" };
  const s = currentSuspension(b);
  if (s) return { kind: s.type === "permanent" ? "banned" : "suspended", s };
  const n = countingNoShows(b).length;
  return { kind: n ? "noshows" : "ok", n };
}
function borrowerPill(st) {
  if (st.kind === "banned") return h("span", { class: "pill banned", text: "Permanently banned" });
  if (st.kind === "suspended") return h("span", { class: "pill banned", text: "Suspended until " + fmtDay(st.s.until) });
  if (st.kind === "noshows") return h("span", { class: "pill strikes", text: st.n + " no-show" + (st.n === 1 ? "" : "s") });
  if (st.kind === "new") return h("span", { class: "pill", text: "New" });
  return h("span", { class: "pill ok", text: "OK" });
}
// Rule 13: €5/day per item, capped at each item's replacement value (when known)
function lateInfo(l, returnedMs) {
  const late = returnedMs - ts(l.returnAt);
  if (late <= 0) return { days: 0, fee: 0, capped: true };
  const days = Math.ceil(late / DAY);
  let fee = 0, capped = true;
  for (const id of l.itemIds || []) {
    const it = itemById(id), per = days * S.settings.lateFeePerDay;
    if (it && Number(it.replacementValue) > 0) fee += Math.min(per, Number(it.replacementValue));
    else { fee += per; capped = false; }
  }
  return { days, fee, capped };
}

// Messages for the Housing Team: the reminder script emails/posts everything in "outbox".
async function notifyHousing(subject, lines) {
  await api.add("outbox", { subject, text: lines.filter(Boolean).join("\n"), createdAt: nowIso(), by: meRef(), sentAt: null });
}
const loanSummary = (l) => [
  "Student: " + l.borrowerName + " (" + l.matric + ")",
  "Items: " + (l.itemNames || []).join(", "),
  "PUDO point: " + pudoLabel(l.pudo),
  "Pickup: " + fmtFull(l.pickupAt) + " · Due back: " + fmtFull(l.returnAt),
];

// ---------------- data layer ----------------
let api;
async function firebaseApi() {
  const [appM, authM, fs] = await Promise.all([import(FB + "firebase-app.js"), import(FB + "firebase-auth.js"), import(FB + "firebase-firestore.js")]);
  const app = appM.initializeApp(CONFIG.firebase);
  const auth = authM.getAuth(app);
  const db = fs.getFirestore(app);
  const ref = (col, id) => fs.doc(db, col, id);
  const toUser = (u) => (u ? { email: lc(u.email), verified: u.emailVerified } : null);
  return {
    onUser: (cb) => authM.onAuthStateChanged(auth, (u) => cb(toUser(u))),
    signIn: (e, p) => authM.signInWithEmailAndPassword(auth, e, p),
    signUp: async (e, p) => { const c = await authM.createUserWithEmailAndPassword(auth, e, p); await authM.sendEmailVerification(c.user); },
    resendVerification: () => authM.sendEmailVerification(auth.currentUser),
    refreshVerified: async () => { await auth.currentUser.reload(); await auth.currentUser.getIdToken(true); return toUser(auth.currentUser); },
    resetPassword: (e) => authM.sendPasswordResetEmail(auth, e),
    signOut: () => authM.signOut(auth),
    watch: (col, cb, onErr) => fs.onSnapshot(fs.collection(db, col), (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), onErr),
    watchDoc: (col, id, cb, onErr) => fs.onSnapshot(ref(col, id), (d) => cb(d.exists() ? { id: d.id, ...d.data() } : null), onErr),
    add: async (col, data) => (await fs.addDoc(fs.collection(db, col), data)).id,
    set: (col, id, data) => fs.setDoc(ref(col, id), data, { merge: true }),
    update: (col, id, data) => fs.updateDoc(ref(col, id), data),
    remove: (col, id) => fs.deleteDoc(ref(col, id)),
  };
}

function demoApi() {
  const data = sampleData();
  const subs = [];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fire = (col) => subs.filter((s) => s.col === col).forEach((s) => s.run());
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) merge(a[k], v);
      else a[k] = v;
    }
    return a;
  };
  let n = 0;
  return {
    demo: true,
    onUser: (cb) => setTimeout(() => cb({ email: "supervisor@university.example", verified: true }), 0),
    signOut: async () => {},
    watch: (col, cb) => { const s = { col, run: () => cb(Object.entries(data[col] || {}).map(([id, v]) => ({ id, ...clone(v) }))) }; subs.push(s); setTimeout(s.run, 0); return () => {}; },
    watchDoc: (col, id, cb) => { const s = { col, run: () => { const v = (data[col] || {})[id]; cb(v ? { id, ...clone(v) } : null); } }; subs.push(s); setTimeout(s.run, 0); return () => {}; },
    add: async (col, d) => { const id = "demo" + (++n) + Math.random().toString(36).slice(2, 7); (data[col] = data[col] || {})[id] = clone(d); fire(col); return id; },
    set: async (col, id, d) => { data[col] = data[col] || {}; data[col][id] = merge(data[col][id] || {}, clone(d)); fire(col); },
    update: async (col, id, d) => { if (!data[col] || !data[col][id]) throw new Error("Not found"); Object.assign(data[col][id], clone(d)); fire(col); },
    remove: async (col, id) => { if (data[col]) delete data[col][id]; fire(col); },
  };
}

function sampleData() {
  const at = (dayOff, hh, mm = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOff); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
  const sup = { email: "supervisor@university.example", name: "Demo Supervisor" };
  const sa = { email: "sam@university.example", name: "Sam (SA)" };
  const hr = new Date().getHours();
  const items = {
    v1: { name: "Vacuum", tag: "V-01", category: "Cleaning", pudo: "TSO", replacementValue: 120, condition: "ok" },
    v2: { name: "Vacuum", tag: "V-02", category: "Cleaning", pudo: "TSO", replacementValue: 120, condition: "ok" },
    v3: { name: "Vacuum", tag: "V-03", category: "Cleaning", pudo: "XD-244", replacementValue: 120, condition: "broken", conditionNote: "Suction weak" },
    v4: { name: "Vacuum", tag: "V-04", category: "Cleaning", pudo: "XD-244", replacementValue: 120, condition: "ok" },
    i1: { name: "Iron", tag: "I-01", category: "Household", pudo: "TSO", replacementValue: 30, condition: "ok" },
    i2: { name: "Iron", tag: "I-02", category: "Household", pudo: "TSO", replacementValue: 30, condition: "ok" },
    m1: { name: "Mop and bucket", tag: "M-01", category: "Cleaning", pudo: "TSO", condition: "ok" },
    p1: { name: "Pool set (2 sticks, balls, holder)", tag: "P-01", category: "Games", pudo: "NC-215", condition: "ok" },
    k1: { name: "Baking kit", tag: "K-01", category: "Kitchen", pudo: "MD-101", condition: "ok" },
  };
  const contract = { at: at(-60, 12), by: sa };
  const borrowers = {
    "30000101": { name: "Example Student A", matric: "30000101", contract, noShows: [], violations: [], suspensions: [] },
    "30000102": { name: "Example Student B", matric: "30000102", contract, noShows: [{ at: at(-12, 10), loanId: "x", by: sa }], violations: [], suspensions: [] },
    "30000103": { name: "Example Student C", matric: "30000103", contract, noShows: [], violations: [], suspensions: [] },
    "30000104": { name: "Example Student D", matric: "30000104", contract, noShows: [{ at: at(-40, 9), by: sa }, { at: at(-20, 9), by: sa }, { at: at(-5, 9), by: sa }], violations: [],
      suspensions: [{ type: "suspension", from: at(-5, 9, 20), until: at(85, 9, 20), reason: "3 no-shows (Rule 17)", auto: true, by: sa }] },
    "30000105": { name: "Example Student E", matric: "30000105", contract, noShows: [], violations: [], suspensions: [] },
  };
  const L = (o) => ({ deleted: false, notes: "", booking: { by: sa, at: at(-3, 12), checks: { contract: true, card: true, residence: true } }, erez: { reservation: true }, contacts: [], remind: {}, ...o });
  const loans = {
    a1: L({ matric: "30000101", borrowerName: "Example Student A", itemIds: ["i1", "i2"], itemNames: ["Iron I-01", "Iron I-02"], pudo: "TSO", pickupAt: at(-4, 16), returnAt: at(-2, 16), status: "out",
      handover: { at: at(-4, 16, 5), by: sa, checks: { card: true, briefed: true } }, erez: { reservation: true, loan: true },
      contacts: [{ at: at(-1, 10), by: sa, method: "Email", note: "No reply" }] }),
    a2: L({ matric: "30000103", borrowerName: "Example Student C", itemIds: ["v1"], itemNames: ["Vacuum V-01"], pudo: "TSO", pickupAt: at(0, Math.max(hr - 1, 0)), returnAt: at(2, Math.max(hr - 1, 0)), status: "booked" }),
    a3: L({ matric: "30000105", borrowerName: "Example Student E", itemIds: ["v2", "m1"], itemNames: ["Vacuum V-02", "Mop and bucket M-01"], pudo: "TSO", pickupAt: at(0, 23, 30), returnAt: at(2, 23, 30), status: "booked", erez: {}, notes: "Also asked for floor cleaning solution" }),
    a4: L({ matric: "30000102", borrowerName: "Example Student B", itemIds: ["p1"], itemNames: ["Pool set (2 sticks, balls, holder) P-01"], pudo: "NC-215", pickupAt: at(-1, 15), returnAt: at(1, 15), status: "out",
      handover: { at: at(-1, 15, 2), by: sup, checks: { card: true, briefed: true }, conditionNote: "All 16 balls present" }, erez: { reservation: true, loan: true } }),
    a5: L({ matric: "30000103", borrowerName: "Example Student C", itemIds: ["k1"], itemNames: ["Baking kit K-01"], pudo: "MD-101", pickupAt: at(3, 14), returnAt: at(5, 14), status: "booked" }),
    a6: L({ matric: "30000101", borrowerName: "Example Student A", itemIds: ["v1"], itemNames: ["Vacuum V-01"], pudo: "TSO", pickupAt: at(-9, 10), returnAt: at(-7, 10), status: "returned",
      returned: { at: at(-7, 9, 50), by: sup, issues: [], lateDays: 0, fee: 0 }, erez: { reservation: true, loan: true, return: true } }),
  };
  return {
    staff: {
      [sup.email]: { email: sup.email, name: sup.name, role: "supervisor", active: true },
      [sa.email]: { email: sa.email, name: sa.name, role: "sa", active: true },
    },
    settings: { main: { ...DEFAULT_SETTINGS, notifyEmail: "housing@university.example" } },
    items, borrowers, loans, outbox: {},
  };
}

// ---------------- render loop ----------------
const app = document.getElementById("app");
const dlg = document.getElementById("dlg");
let mainEl = null, views = null, raf = 0;
function schedule() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; refresh(); }); }
function refresh() { if (!mainEl || !views) return; updateNavBadges(); views[S.view].update(); }

const TABS = [["today", "Today"], ["calendar", "Calendar"], ["loans", "Loans"], ["items", "Inventory"], ["borrowers", "Borrowers"], ["logs", "Logs"], ["settings", "Settings"]];
function renderShell() {
  app.textContent = "";
  const tabs = TABS.filter(([k]) => k !== "settings" || isSup());
  if (!tabs.some(([k]) => k === S.view)) S.view = "today";
  app.append(
    h("div", { class: "top" },
      h("h1", null, "Lending ", h("span", { text: "Library" })),
      h("div", { class: "who" },
        h("span", null, h("b", { text: meRef().name }), " · " + (isSup() ? "Supervisor" : "Student Assistant")),
        api.demo ? null : h("button", { class: "btn btn-ghost btn-sm", onclick: () => api.signOut() }, "Sign out"))),
    api.demo ? h("div", { class: "demo" }, h("b", null, "Demo mode. "), "Made-up sample data; nothing is saved. Add the Firebase settings to config.js to switch to the real version.") : "",
    h("nav", { class: "tabs", role: "tablist" }, tabs.map(([k, label]) =>
      h("button", { class: "tab", role: "tab", id: "tab-" + k, "aria-selected": String(S.view === k), onclick: () => go(k) }, label, h("span", { class: "badge", id: "badge-" + k, hidden: true })))));
  mainEl = h("main", { class: "section" });
  app.append(mainEl);
  views[S.view].mount(mainEl);
  refresh();
}
function go(view) {
  S.view = view; S.armed = null;
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.id === "tab-" + view)));
  try { history.replaceState(null, "", "#" + view); } catch (e) {}
  mainEl.textContent = "";
  views[view].mount(mainEl);
  refresh();
}
function needsAction() { return liveLoans().filter((l) => ["missed", "overdue"].includes(loanState(l))); }
function updateNavBadges() {
  const set = (id, n, hot) => { const b = document.getElementById("badge-" + id); if (b) { b.hidden = !n; b.textContent = String(n); b.className = "badge" + (hot ? " hot" : ""); } };
  set("today", needsAction().length, true);
  set("loans", liveLoans().filter(isOpen).length, false);
}

function disarmAll() { document.querySelectorAll(".btn-danger.armed[data-label]").forEach((b) => { b.classList.remove("armed"); b.textContent = b.dataset.label; }); }
function armedButton(key, label, confirmLabel, action) {
  const armed = S.armed === key;
  const b = h("button", { class: "btn btn-danger btn-sm" + (armed ? " armed" : ""), type: "button", text: armed ? confirmLabel : label, "data-label": label });
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (S.armed !== key) { disarmAll(); S.armed = key; b.classList.add("armed"); b.textContent = confirmLabel; return; }
    S.armed = null; b.disabled = true;
    try { await action(); } catch (err) { toast(errText(err), true); b.disabled = false; }
    refresh();
  });
  return b;
}
document.addEventListener("click", (e) => { if (S.armed && !e.target.closest(".btn-danger")) { S.armed = null; disarmAll(); } });

function errText(err) {
  const c = String((err && err.code) || "");
  if (c.includes("permission")) return "You don't have permission to do that.";
  if (c.includes("unavailable")) return "You're offline. Check your connection and try again.";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Email or password is wrong.";
  if (c.includes("email-already-in-use")) return "An account with this email already exists. Sign in instead, or reset the password.";
  if (c.includes("weak-password")) return "Use a password with at least 8 characters.";
  if (c.includes("too-many-requests")) return "Too many attempts. Wait a few minutes and try again.";
  return (err && err.message) || "Something went wrong. Try again.";
}
let toastEl = null;
function toast(text, bad) {
  if (!toastEl) {
    toastEl = h("div", { role: "status", class: "toast" });
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.toggle("bad", !!bad);
  toastEl.hidden = false;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.hidden = true; }, 5000);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied. Paste it into the spreadsheet."); }
  catch (e) { toast("Couldn't copy automatically. Use the CSV download instead.", true); }
}
function downloadCsv(name, rows) {
  const csv = rows.map((r) => r.map((c) => '"' + String(c === undefined || c === null ? "" : c).replace(/"/g, '""') + '"').join(",")).join("\r\n");
  const a = h("a", { href: URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })), download: name });
  document.body.append(a); a.click(); a.remove();
}

// ---------------- dialog helper ----------------
function openDialog(title, body, { submitLabel = "Save", onSubmit, wide = false } = {}) {
  dlg.textContent = "";
  const err = h("span", { class: "err", role: "alert" });
  const submit = h("button", { class: "btn btn-primary", type: "submit", text: submitLabel });
  const form = h("form", { class: "dlg", novalidate: true },
    h("div", { class: "dlg-head" }, h("h2", { text: title }), h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => dlg.close(), text: "Close" })),
    body,
    onSubmit ? h("div", { class: "dlg-foot" }, err, h("button", { class: "btn btn-ghost", type: "button", onclick: () => dlg.close(), text: "Cancel" }), submit) : null);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = ""; submit.disabled = true;
    try { const res = await onSubmit(); if (typeof res === "string") { err.textContent = res; return; } dlg.close(); }
    catch (ex) { err.textContent = errText(ex); }
    finally { submit.disabled = false; }
  });
  dlg.style.width = wide ? "min(780px, calc(100vw - 24px))" : "";
  dlg.append(form);
  dlg.showModal();
  const first = form.querySelector("input:not([type=checkbox]),select,textarea");
  if (first) first.focus();
}
const field = (label, input, hint) => h("div", { class: "field" }, h("label", { for: input.id, text: label }), input, hint ? h("span", { class: "muted small", text: hint }) : null);
const check = (id, label, checked) => { const c = h("input", { type: "checkbox", id, checked: !!checked }); return { el: h("label", { class: "check", for: id }, c, h("span", null, label)), input: c }; };
const conditionSelect = (id, value) => { const s = h("select", { id }, h("option", { value: "ok", text: "OK" }), h("option", { value: "broken", text: "Broken" }), h("option", { value: "missing", text: "Missing" })); s.value = value || "ok"; return s; };
function pudoSelect(id, value, includeInactive) {
  const s = h("select", { id }, pudos().filter((p) => p.active || includeInactive || p.id === value).map((p) => h("option", { value: p.id, text: p.room + " · " + p.building + (p.active ? "" : " (not active)") })));
  if (value) s.value = value;
  return s;
}

// ---------------- loan actions ----------------
function openHandover(l) {
  const b = borrowerOf(l.matric), st = borrowerState(b);
  const card = check("h-card", "Campus card shown and identity matches", false);
  const briefed = check("h-brief", "Borrower briefed (see list)", false);
  const erez = check("h-erez", "Loan logged in eRezLife", !!(l.erez && l.erez.loan));
  const cond = h("textarea", { id: "h-cond", rows: 2, placeholder: "e.g. small scratch on handle, all parts present. Photos go where you keep them now." });
  const blocked = st.kind === "suspended" || st.kind === "banned";
  openDialog("Hand over", [
    h("p", { class: "muted", text: (l.itemNames || []).join(", ") + " · " + l.borrowerName + " (" + l.matric + ") · " + pudoLabel(l.pudo) }),
    blocked ? h("div", { class: "banner bad", text: l.borrowerName + " is on the suspension/ban list. Do not hand over the item. Tell the student their status." }) : h("div", { class: "banner info", text: "Ban list re-checked: not suspended or banned." }),
    h("div", { class: "checks" }, card.el),
    field("Condition at pickup", cond, "Rule 7: record the condition. Note any damage the student points out."),
    h("div", { class: "brief" }, h("span", { class: "label", text: "Tell the borrower" }), h("ul", null,
      h("li", { text: "Return to " + pudoShort(l.pudo) + " on " + fmtFull(l.returnAt) + "." }),
      h("li", { text: "Personal use only, not for friends or anyone else." }),
      h("li", { text: "They're responsible for damage while it's with them." }),
      h("li", { text: "One extension of up to " + S.settings.extensionDays + " days can be asked for before the due date, only if nobody else booked it." }),
      h("li", { text: "Late returns cost €" + S.settings.lateFeePerDay + " per day, up to the item's value. Unpaid charges come from the deposit; disputes in writing to Housing within 7 days." }))),
    h("div", { class: "checks" }, briefed.el, erez.el),
  ], {
    submitLabel: "Hand over",
    onSubmit: async () => {
      if (blocked) return "This student is suspended or banned.";
      if (!card.input.checked) return "Check the campus card first.";
      if (!briefed.input.checked) return "Brief the borrower first.";
      await api.update("loans", l.id, {
        status: "out",
        handover: { at: nowIso(), by: meRef(), checks: { card: true, briefed: true }, conditionNote: norm(cond.value) },
        erez: { ...(l.erez || {}), loan: erez.input.checked },
      });
      toast("Handed over." + (erez.input.checked ? "" : " Remember to log the loan in eRezLife."));
    },
  });
}

async function noShow(l) {
  const b = borrowerOf(l.matric) || { noShows: [], suspensions: [] };
  const entry = { at: nowIso(), loanId: l.id, items: (l.itemNames || []).join(", "), pudo: l.pudo, by: meRef() };
  const noShows = [...(b.noShows || []), entry];
  const next = { ...b, noShows };
  const counting = countingNoShows(next).length;
  const update = { noShows };
  let suspended = false;
  if (counting >= S.settings.noShowLimit && !currentSuspension(b)) {
    const until = new Date(Date.now() + S.settings.suspensionDays * DAY).toISOString();
    update.suspensions = [...(b.suspensions || []), { type: "suspension", from: nowIso(), until, reason: counting + " no-shows (Rule 17)", auto: true, by: meRef() }];
    suspended = true;
  }
  await api.update("loans", l.id, { status: "noshow", closedAt: nowIso(), closedBy: meRef() });
  await api.set("borrowers", l.matric, update);
  if (suspended) {
    await notifyHousing("Suspension: " + l.borrowerName + " (" + l.matric + ") — " + counting + " no-shows", [
      l.borrowerName + " (" + l.matric + ") reached " + counting + " no-shows and is suspended from the Lending Library for " + Math.round(S.settings.suspensionDays / 30) + " months, until " + fmtFull(update.suspensions.at(-1).until) + ".",
      "Latest no-show: " + (l.itemNames || []).join(", ") + " at " + pudoLabel(l.pudo) + ", " + fmtFull(l.pickupAt) + ".",
      "Logged by " + meRef().name + ". Please update the Suspension/Ban List if you keep it separately.",
    ]);
    toast(l.borrowerName + " reached " + counting + " no-shows and is now suspended. The Housing Team will be emailed.");
  } else toast("No-show logged (" + counting + " of " + S.settings.noShowLimit + "). Also add it to the No-Show Log.");
}

function openReturn(l) {
  const when = h("input", { id: "r-when", type: "datetime-local", value: toInput(new Date()) });
  const clean = check("r-clean", "Clean", true), complete = check("r-complete", "Complete (all parts)", true), undamaged = check("r-ok", "Not damaged", true);
  const erez = check("r-erez", "Return logged in eRezLife", !!(l.erez && l.erez.return));
  const conds = (l.itemIds || []).map((id) => { const it = itemById(id); return { id, it, sel: conditionSelect("r-cond-" + id, it ? it.condition : "ok") }; });
  const note = h("textarea", { id: "r-note", rows: 2, placeholder: "What's wrong, if anything" });
  const lateBox = h("div");
  const drawLate = () => {
    lateBox.textContent = ""; lateBox.className = "";
    const t = ts(when.value);
    if (isNaN(t)) return;
    const li = lateInfo(l, t);
    if (li.days) {
      lateBox.className = "banner warn";
      lateBox.textContent = "Late by " + li.days + " day" + (li.days === 1 ? "" : "s") + " (each started day counts). Late fee up to " + euro(li.fee) + (li.capped ? "" : " (replacement value unknown, so not capped)") + ". Tell the borrower the Housing Team will follow up on charges.";
    } else { lateBox.className = "banner info"; lateBox.textContent = "On time."; }
  };
  when.addEventListener("change", drawLate); drawLate();
  openDialog("Return", [
    h("p", { class: "muted", text: (l.itemNames || []).join(", ") + " · " + l.borrowerName + " · due " + fmtFull(l.returnAt) + " at " + pudoShort(l.pudo) }),
    l.handover && l.handover.conditionNote ? h("div", { class: "banner info", text: "Condition at pickup: " + l.handover.conditionNote }) : null,
    field("Returned at", when), lateBox,
    h("span", { class: "label", text: "Compare with the condition at pickup" }),
    h("div", { class: "checks" }, clean.el, complete.el, undamaged.el),
    conds.length ? h("fieldset", null, h("legend", { class: "label", text: "Item condition now (updates the inventory)" }), conds.map((c) => field(c.it ? itemLabel(c.it) : c.id, c.sel))) : null,
    field("Note", note), h("div", { class: "checks" }, erez.el),
  ], {
    submitLabel: "Log return",
    onSubmit: async () => {
      const t = ts(when.value);
      if (isNaN(t)) return "Enter when it was returned.";
      const issues = [!clean.input.checked && "dirty", !complete.input.checked && "incomplete", !undamaged.input.checked && "damaged"].filter(Boolean);
      if (issues.length && !norm(note.value)) return "Describe what's wrong in the note.";
      const li = lateInfo(l, t);
      const at = new Date(t).toISOString();
      await api.update("loans", l.id, {
        status: "returned", closedAt: at,
        returned: { at, by: meRef(), issues, note: norm(note.value), lateDays: li.days, fee: li.fee, feeCapped: li.capped, escalated: !!(issues.length || li.days) },
        erez: { ...(l.erez || {}), return: erez.input.checked },
      });
      for (const c of conds) {
        if (c.it && c.sel.value !== (c.it.condition || "ok")) await api.update("items", c.id, { condition: c.sel.value, conditionNote: c.sel.value === "ok" ? "" : "On return: " + (norm(note.value) || "no details") });
      }
      if (issues.length || li.days) {
        const b = borrowerOf(l.matric) || {};
        const v = { at, loanId: l.id, items: (l.itemNames || []).join(", "), types: [...issues, ...(li.days ? ["late"] : [])], lateDays: li.days, fee: li.fee, note: norm(note.value), by: meRef() };
        await api.set("borrowers", l.matric, { violations: [...(b.violations || []), v] });
        await notifyHousing("Lending Library escalation: " + l.borrowerName + " (" + l.matric + ") — " + v.types.join(", "), [
          ...loanSummary(l),
          "Returned: " + fmtFull(at) + (li.days ? " — " + li.days + " day(s) late, late fee up to " + euro(li.fee) + (li.capped ? "" : " (replacement value unknown)") : ""),
          issues.length ? "Condition: " + issues.join(", ") : "",
          norm(note.value) ? "Note: " + norm(note.value) : "",
          l.handover && l.handover.conditionNote ? "Condition at pickup: " + l.handover.conditionNote : "",
          "Logged by " + meRef().name + ". The borrower was told the Housing Team will follow up on charges.",
        ]);
        toast("Return logged and escalated to the Housing Team.");
      } else toast("Return logged. No charge.");
    },
  });
}

function openExtend(l) {
  const due = ts(l.returnAt);
  const max = addDays(due, S.settings.extensionDays).getTime();
  const until = h("input", { id: "x-until", type: "datetime-local", value: toInput(new Date(max)) });
  openDialog("Extend loan", [
    h("p", { class: "muted", text: "Rule 4: one extension of up to " + S.settings.extensionDays + " days, asked for before the due date, and only if nobody else has booked the item." }),
    field("New due date", until, "Latest possible: " + fmtFull(new Date(max).toISOString())),
  ], {
    submitLabel: "Extend",
    onSubmit: async () => {
      const t = ts(until.value);
      if (isNaN(t)) return "Pick the new due date.";
      if (t <= due) return "The new date must be after the current due date.";
      if (t > max + MIN) return "Extensions are up to " + S.settings.extensionDays + " days.";
      for (const id of l.itemIds || []) {
        const c = itemClash(id, due, t, l.id);
        if (c) return "Can't extend: " + (itemById(id) ? itemLabel(itemById(id)) : id) + " is booked by another student from " + fmtFull(c.pickupAt) + ".";
      }
      await api.update("loans", l.id, { returnAt: new Date(t).toISOString(), extension: { at: nowIso(), by: meRef(), from: l.returnAt }, remind: { ...(l.remind || {}), back30: null, back15: null } });
      toast("Extended to " + fmtFull(new Date(t).toISOString()) + ".");
    },
  });
}

function openCancel(l) {
  const reason = h("input", { id: "c-reason", placeholder: "e.g. student cancelled in advance, item faulty" });
  openDialog("Cancel reservation", [
    h("p", { class: "muted", text: "Use this when the student cancelled in advance or the item can't be lent. It is not a no-show." }),
    field("Reason", reason),
  ], {
    submitLabel: "Cancel reservation",
    onSubmit: async () => {
      if (!norm(reason.value)) return "Give a short reason.";
      await api.update("loans", l.id, { status: "cancelled", cancelReason: norm(reason.value), closedAt: nowIso(), closedBy: meRef() });
      toast("Reservation cancelled. Update eRezLife too.");
    },
  });
}

function openContact(l) {
  const when = h("input", { id: "k-when", type: "datetime-local", value: toInput(new Date()) });
  const method = h("select", { id: "k-method" }, ["Email", "Outlook/Teams message", "In person", "Phone"].map((m) => h("option", { value: m, text: m })));
  const note = h("input", { id: "k-note", placeholder: "e.g. no reply yet" });
  const n = (l.contacts || []).length;
  openDialog("Log contact attempt", [
    h("p", { class: "muted", text: l.borrowerName + " (" + l.matric + ") · " + (l.itemNames || []).join(", ") + " · due " + fmtFull(l.returnAt) + ". This will be attempt " + (n + 1) + "." }),
    h("div", { class: "grid2" }, field("When", when), field("How", method)), field("Note", note),
  ], {
    submitLabel: "Log attempt",
    onSubmit: async () => {
      const t = ts(when.value);
      if (isNaN(t)) return "Enter when you contacted them.";
      await api.update("loans", l.id, { contacts: [...(l.contacts || []), { at: new Date(t).toISOString(), method: method.value, note: norm(note.value), by: meRef() }] });
      toast("Attempt " + (n + 1) + " logged.");
    },
  });
}
async function escalateOverdue(l) {
  const b = borrowerOf(l.matric) || {};
  await notifyHousing("Unreturned item: " + l.borrowerName + " (" + l.matric + ")", [
    ...loanSummary(l),
    "Overdue since " + fmtFull(l.returnAt) + ". Late fee so far up to " + euro(lateInfo(l, Date.now()).fee) + ".",
    "Contact attempts:",
    ...(l.contacts || []).map((c, i) => "  " + (i + 1) + ". " + fmtFull(c.at) + " · " + c.method + (c.note ? " · " + c.note : "") + " · " + (c.by ? c.by.name : "")),
    "Escalated by " + meRef().name + ".",
  ]);
  await api.update("loans", l.id, { escalatedAt: nowIso(), escalatedBy: meRef() });
  await api.set("borrowers", l.matric, { violations: [...(b.violations || []), { at: nowIso(), loanId: l.id, items: (l.itemNames || []).join(", "), types: ["not returned"], note: (l.contacts || []).length + " contact attempts", by: meRef() }] });
  toast("Escalated to the Housing Team with the contact log.");
}
async function closeNotReturned(l) {
  await api.update("loans", l.id, { status: "notreturned", closedAt: nowIso(), closedBy: meRef() });
  for (const id of l.itemIds || []) if (itemById(id)) await api.update("items", id, { condition: "missing", conditionNote: "Not returned by " + l.borrowerName });
  toast("Closed as not returned. Items marked missing.");
}
async function toggleErez(l, key) {
  await api.update("loans", l.id, { erez: { ...(l.erez || {}), [key]: !(l.erez && l.erez[key]) } });
}

// ---------------- booking ----------------
function openLoanForm(existing, preset = {}) {
  const l = existing || null;
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(14, 0, 0, 0);
  const matric = h("input", { id: "f-matric", inputmode: "numeric", autocomplete: "off", placeholder: "e.g. 30009280", value: l ? l.matric : "" });
  const name = h("input", { id: "f-name", autocomplete: "off", placeholder: "Student's full name", value: l ? l.borrowerName : "" });
  const status = h("div", { class: "section" });
  const cContract = check("f-contract", "Signed Contract Amendment is on file", false);
  const cCard = check("f-card", "Campus card shown", !!l);
  const cRes = check("f-res", "Lives on campus (active, current residence)", !!l);
  const cErez = check("f-erez", "Reservation logged in eRezLife", !!(l && l.erez && l.erez.reservation));
  const pudo = pudoSelect("f-pudo", l ? l.pudo : preset.pudo || (pudos().find((p) => p.active) || {}).id);
  const outAt = h("input", { id: "f-out", type: "datetime-local", value: toInput(l ? new Date(l.pickupAt) : tomorrow) });
  const backAt = h("input", { id: "f-back", type: "datetime-local", value: toInput(l ? new Date(l.returnAt) : addDays(tomorrow, S.settings.loanDays)) });
  const timeNote = h("div");
  const reason = h("input", { id: "f-reason", placeholder: "Why the 24-hour rule is being skipped" });
  const reasonWrap = field("Reason for the exception", reason);
  const notes = h("textarea", { id: "f-notes", rows: 2, placeholder: "Anything the next SA should know", value: l ? l.notes || "" : "" });
  const chosen = new Set(l ? l.itemIds || [] : preset.itemId ? [preset.itemId] : []);
  const pick = h("div", { class: "pick", role: "group", "aria-label": "Items" });
  let backTouched = !!l;
  const bookedAt = l ? ts((l.booking && l.booking.at) || l.loggedAt || nowIso()) : Date.now();

  const curMatric = () => norm(matric.value).replace(/\s+/g, "");
  function drawStatus() {
    status.textContent = "";
    const m = curMatric();
    const b = borrowerOf(m);
    if (b && !norm(name.value)) name.value = b.name || "";
    cContract.el.hidden = !!(b && b.contract);
    if (!m) { status.append(cContract.el); return; }
    const st = borrowerState(b);
    if (st.kind === "suspended" || st.kind === "banned") status.append(h("div", { class: "banner bad", text: (b.name || m) + (st.kind === "banned" ? " is permanently banned" : " is suspended until " + fmtFull(st.s.until)) + " (" + st.s.reason + "). Do not reserve. Tell the student their status." }));
    else if (st.kind === "noshows") status.append(h("div", { class: "banner warn", text: (b.name || m) + " has " + st.n + " no-show" + (st.n === 1 ? "" : "s") + ". At " + S.settings.noShowLimit + " they're suspended for 3 months." }));
    const held = heldItems(m, l && l.id);
    if (held) status.append(h("div", { class: "banner " + (held >= S.settings.itemLimit ? "bad" : "info"), text: "Already has " + held + " item" + (held === 1 ? "" : "s") + " reserved or borrowed (limit " + S.settings.itemLimit + ")." }));
    if (b && b.contract) status.append(h("div", { class: "banner info", text: "Contract Amendment on file since " + fmtDate(b.contract.at) + "." }));
    else status.append(cContract.el);
  }
  function drawTimes() {
    timeNote.textContent = ""; timeNote.className = "";
    const o = ts(outAt.value), bk = ts(backAt.value);
    reasonWrap.hidden = true;
    if (isNaN(o)) return;
    const msgs = [];
    if (!advanceOk(o, bookedAt)) {
      if (isSup()) msgs.push(["warn", "Same-day pickup. Rule 3 says reservations must be made the day before; as a supervisor you can allow it."]);
      else if (S.settings.advanceRule === "strict") msgs.push(["bad", "Pickup must be on a later day than today (Rule 3). Only a supervisor can make an exception."]);
      else { msgs.push(["warn", "Pickup must normally be on a later day than today (Rule 3). Give a reason to make an exception; supervisors will see it."]); reasonWrap.hidden = false; }
    }
    if (!isNaN(bk) && bk > addDays(o, S.settings.loanDays).getTime() + MIN) msgs.push(["warn", "That's longer than the " + S.settings.loanDays + "-day loan period (Rule 4)."]);
    if (msgs.length) { timeNote.className = "section"; msgs.forEach(([k, t]) => timeNote.append(h("div", { class: "banner " + k, text: t }))); }
  }
  function drawPick() {
    pick.textContent = "";
    const a = ts(outAt.value), b = ts(backAt.value);
    const here = S.items.filter((it) => it.pudo === pudo.value).sort((x, y) => itemLabel(x).localeCompare(itemLabel(y)));
    for (const id of [...chosen]) if (!here.some((it) => it.id === id) && !l) chosen.delete(id);
    if (!here.length) { pick.append(h("span", { class: "muted small", text: "No items at " + pudoShort(pudo.value) + " yet. Add them on the Inventory tab." })); return; }
    for (const it of here) {
      let why = "";
      if (it.condition === "broken" || it.condition === "missing") why = it.condition === "broken" ? "Broken" : "Missing";
      else if (!isNaN(a) && !isNaN(b)) { const c = itemClash(it.id, a, b, l && l.id); if (c) why = "Booked " + fmtDay(c.pickupAt) + "–" + fmtDay(c.returnAt); }
      const off = !!why && !chosen.has(it.id);
      const cb = h("input", { type: "checkbox", id: "pick-" + it.id, checked: chosen.has(it.id), disabled: off });
      cb.addEventListener("change", () => { cb.checked ? chosen.add(it.id) : chosen.delete(it.id); });
      pick.append(h("label", { class: off ? "off" : "", for: "pick-" + it.id }, cb, h("span", null, it.name, it.tag ? h("span", { class: "tag", style: "margin-left:6px", text: it.tag }) : null), why ? h("span", { class: "why", text: why }) : null));
    }
  }
  matric.addEventListener("input", drawStatus);
  pudo.addEventListener("change", drawPick);
  outAt.addEventListener("change", () => {
    const o = ts(outAt.value);
    if (!isNaN(o) && !backTouched) backAt.value = toInput(addDays(o, S.settings.loanDays));
    drawTimes(); drawPick();
  });
  backAt.addEventListener("change", () => { backTouched = true; drawTimes(); drawPick(); });
  drawStatus(); drawTimes(); drawPick();

  openDialog(l ? "Edit reservation" : "New reservation", [
    h("div", { class: "grid2" }, field("Matriculation number", matric), field("Student name", name)),
    status,
    l ? null : h("div", { class: "checks" }, cCard.el, cRes.el),
    h("div", { class: "grid3" }, field("PUDO point", pudo), field("Pickup", outAt), field("Return (same PUDO point)", backAt)),
    timeNote, reasonWrap,
    h("div", { class: "field" }, h("span", { class: "label-text", text: "Items at this PUDO point" }), pick),
    field("Notes (optional)", notes),
    h("div", { class: "checks" }, cErez.el),
  ], {
    wide: true,
    submitLabel: l ? "Save changes" : "Reserve",
    onSubmit: async () => {
      const m = curMatric(), nm = norm(name.value);
      if (!/^\d{5,12}$/.test(m)) return "Enter the matriculation number (digits only).";
      if (!nm) return "Enter the student's name.";
      const b = borrowerOf(m);
      const st = borrowerState(b);
      if (st.kind === "suspended" || st.kind === "banned") return nm + " is on the suspension/ban list. Don't reserve.";
      if (!(b && b.contract) && !cContract.input.checked) return "A signed Contract Amendment must be on file before the first loan.";
      if (!l && !cCard.input.checked) return "Check the campus card first.";
      if (!l && !cRes.input.checked) return "Only students living on campus can borrow.";
      const a = new Date(outAt.value), bk = new Date(backAt.value);
      if (isNaN(a) || isNaN(bk)) return "Enter the pickup and return times.";
      if (bk <= a) return "The return has to be after the pickup.";
      if (!pudoById(pudo.value)) return "Choose a PUDO point.";
      if (!chosen.size) return "Tick at least one item.";
      const held = heldItems(m, l && l.id);
      if (held + chosen.size > S.settings.itemLimit) return "Item limit: " + nm + " already has " + held + " reserved or borrowed, and the limit is " + S.settings.itemLimit + " (Rule 5).";
      let exception = null;
      if (!advanceOk(a.getTime(), bookedAt) && (!l || ts(l.pickupAt) !== a.getTime())) {
        if (isSup()) exception = { reason: norm(reason.value) || "Allowed by supervisor", by: meRef(), at: nowIso() };
        else if (S.settings.advanceRule === "strict") return "Pickup must be on a later day than today. Ask a supervisor.";
        else if (!norm(reason.value)) return "Give a reason for skipping the 24-hour rule.";
        else exception = { reason: norm(reason.value), by: meRef(), at: nowIso() };
      }
      for (const id of chosen) {
        const it = itemById(id);
        if (!it) return "One of the ticked items no longer exists.";
        if (it.pudo !== pudo.value) return itemLabel(it) + " is kept at " + pudoShort(it.pudo) + ", not " + pudoShort(pudo.value) + ".";
        const c = itemClash(id, a.getTime(), bk.getTime(), l && l.id);
        if (c) return itemLabel(it) + " is already booked for " + c.borrowerName + " (" + fmtFull(c.pickupAt) + " to " + fmtFull(c.returnAt) + ").";
        if (!l && (it.condition === "broken" || it.condition === "missing")) return itemLabel(it) + " is marked " + it.condition + ".";
      }
      const ids = [...chosen];
      const body = {
        matric: m, borrowerName: nm, pudo: pudo.value, itemIds: ids, itemNames: ids.map((id) => itemLabel(itemById(id))),
        pickupAt: a.toISOString(), returnAt: bk.toISOString(), notes: norm(notes.value),
        erez: { ...((l && l.erez) || {}), reservation: cErez.input.checked },
      };
      if (exception) body.advanceException = exception;
      const bUpdate = { matric: m, name: nm };
      if (!(b && b.contract) && cContract.input.checked) bUpdate.contract = { at: nowIso(), by: meRef() };
      await api.set("borrowers", m, bUpdate);
      if (l) {
        const timesChanged = l.pickupAt !== body.pickupAt || l.returnAt !== body.returnAt;
        await api.update("loans", l.id, { ...body, editedAt: nowIso(), editedBy: meRef(), ...(timesChanged ? { remind: {} } : {}) });
        toast("Reservation updated.");
      } else {
        await api.add("loans", { ...body, status: "booked", deleted: false, booking: { at: nowIso(), by: meRef(), checks: { contract: true, card: true, residence: true } }, contacts: [], remind: {} });
        toast("Reserved. Reminders go out 30 and 15 minutes before pickup and return." + (cErez.input.checked ? "" : " Remember to log it in eRezLife."));
      }
    },
  });
}

// ---------------- shared bits ----------------
function erezChips(l) {
  const wrap = h("div", { class: "erez" }, h("span", { class: "muted small", text: "eRezLife:" }));
  const keys = [["reservation", "reservation"], ["loan", "loan"], ["return", "return"]];
  const needed = l.status === "booked" ? 1 : l.status === "out" ? 2 : l.status === "returned" ? 3 : 1;
  keys.slice(0, needed).forEach(([k, label]) => {
    const on = !!(l.erez && l.erez[k]);
    wrap.append(h("button", { class: "erez-chip" + (on ? " on" : ""), type: "button", "aria-pressed": String(on), title: on ? "Logged in eRezLife. Click to undo." : "Click once it's logged in eRezLife", onclick: () => toggleErez(l, k).catch((e) => toast(errText(e), true)) }, (on ? "✓ " : "") + label));
  });
  return wrap;
}

function loanCard(l) {
  const st = loanState(l), closed = !isOpen(l);
  const card = h("article", { class: "loan is-" + st + (closed ? " is-closed" : "") });
  card.append(h("div", { class: "loan-top" },
    h("div", null, h("h3", { text: (l.itemNames || []).join(", ") }), h("div", { class: "muted small" }, l.borrowerName + " · ", h("span", { class: "mono", text: l.matric }), " · " + pudoLabel(l.pudo))),
    h("div", { class: "pills" },
      l.escalatedAt ? h("span", { class: "pill missing", text: "Escalated" }) : null,
      l.extension ? h("span", { class: "pill", text: "Extended" }) : null,
      h("span", { class: "pill " + st, text: LOAN_LABEL[st] }))));
  const leg = (kind) => {
    const iso = kind === "out" ? l.pickupAt : l.returnAt;
    return h("div", { class: "leg " + kind },
      h("span", { class: "label", text: kind === "out" ? "Pickup" : "Return" }),
      h("span", { class: "stamp", text: fmtFull(iso) }),
      h("span", { class: "place", text: pudoShort(l.pudo) + (closed ? "" : " · " + rel(iso)) }));
  };
  card.append(h("div", { class: "slip" }, leg("out"), leg("back")));
  const meta = [];
  if (l.notes) meta.push("Notes: " + l.notes);
  if (l.advanceException) meta.push("24-hour rule exception: " + l.advanceException.reason + " (" + l.advanceException.by.name + ")");
  if (l.extension) meta.push("Extended on " + fmtDay(l.extension.at) + " from " + fmtFull(l.extension.from) + " by " + l.extension.by.name);
  if (l.handover) meta.push("Handed over " + fmtFull(l.handover.at) + " by " + l.handover.by.name + (l.handover.conditionNote ? " · condition: " + l.handover.conditionNote : ""));
  if (l.returned) meta.push("Returned " + fmtFull(l.returned.at) + " to " + l.returned.by.name + ((l.returned.issues || []).length ? " · " + l.returned.issues.join(", ") : "") + (l.returned.lateDays ? " · " + l.returned.lateDays + " day(s) late, fee up to " + euro(l.returned.fee) : "") + (l.returned.note ? " · " + l.returned.note : "") + (l.returned.escalated ? " · escalated to Housing" : ""));
  if (l.status === "cancelled") meta.push("Cancelled: " + (l.cancelReason || ""));
  if (l.status === "noshow") meta.push("No-show logged" + (l.closedBy ? " by " + l.closedBy.name : ""));
  if ((l.contacts || []).length) meta.push("Contact attempts: " + l.contacts.map((c) => fmtDay(c.at) + " " + fmtTime(c.at) + " (" + c.method + ")").join(", "));
  meta.push("Reserved by " + ((l.booking && l.booking.by && l.booking.by.name) || "unknown") + (l.booking ? " on " + fmtDay(l.booking.at) : ""));
  card.append(h("div", { class: "loan-meta" }, meta.map((t) => h("span", { text: t })), erezChips(l)));
  const foot = h("div", { class: "loan-foot" });
  if (l.status === "booked") {
    foot.append(h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => openHandover(l), text: "Hand over" }));
    if (st === "missed") foot.append(armedButton("noshow:" + l.id, "No-show", "Confirm no-show", () => noShow(l)));
    foot.append(h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openCancel(l), text: "Cancel" }));
    foot.append(h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openLoanForm(l), text: "Edit" }));
  }
  if (l.status === "out") {
    foot.append(h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => openReturn(l), text: "Returned" }));
    if (!l.extension && st === "out") foot.append(h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openExtend(l), text: "Extend" }));
    if (st === "overdue") {
      const n = (l.contacts || []).length;
      foot.append(h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openContact(l), text: "Log contact (" + n + "/" + S.settings.contactAttempts + ")" }));
      if (n >= S.settings.contactAttempts && !l.escalatedAt) foot.append(armedButton("esc:" + l.id, "Escalate to Housing", "Confirm escalate", () => escalateOverdue(l)));
      if (isSup() && l.escalatedAt) foot.append(armedButton("nr:" + l.id, "Close as not returned", "Confirm close", () => closeNotReturned(l)));
    }
  }
  if (isSup()) { foot.append(h("span", { class: "spacer" })); foot.append(armedButton("del:" + l.id, "Delete", "Confirm delete", () => api.update("loans", l.id, { deleted: true, deletedBy: meRef(), deletedAt: nowIso() }).then(() => toast("Deleted.")))); }
  if (foot.childNodes.length) card.append(foot);
  return card;
}
const empty = (title, text) => h("div", { class: "empty" }, h("strong", { text: title }), h("span", { text }));
const loading = () => empty("Loading…", "Fetching the latest data.");

// events for timeline-style lists
function eventsBetween(a, b) {
  const evs = [];
  for (const l of liveLoans()) {
    if (!isOpen(l)) continue;
    if (l.status === "booked") evs.push({ kind: "out", at: l.pickupAt, l });
    evs.push({ kind: "back", at: l.returnAt, l });
  }
  return evs.filter((e) => ts(e.at) >= a && ts(e.at) < b).sort((x, y) => ts(x.at) - ts(y.at));
}
function evRow(e, showDay) {
  const l = e.l, st = loanState(l);
  const late = e.kind === "late";
  const iso = late ? (st === "missed" ? l.pickupAt : l.returnAt) : e.at;
  const acts = h("div", { class: "acts" });
  if (l.status === "booked" && (e.kind === "out" || late)) {
    acts.append(h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => openHandover(l), text: "Hand over" }));
    if (st === "missed") acts.append(armedButton("noshow:" + l.id, "No-show", "Confirm no-show", () => noShow(l)));
  } else if (l.status === "out" && (e.kind === "back" || late)) {
    acts.append(h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => openReturn(l), text: "Returned" }));
    if (st === "overdue") acts.append(h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openContact(l), text: "Log contact (" + (l.contacts || []).length + ")" }));
  }
  const label = late ? (st === "missed" ? "NO-SHOW?" : "LATE") : e.kind === "out" ? "PICKUP" : "RETURN";
  let sub = l.borrowerName + " · " + l.matric + " · " + pudoShort(l.pudo);
  if (late && st === "missed") sub += " · was due " + fmtFull(iso) + ". If they didn't come and didn't cancel, log a no-show.";
  else if (late) sub += " · due " + fmtFull(iso) + " (" + rel(iso) + ")" + (l.escalatedAt ? " · escalated" : "");
  else if (showDay) sub += " · " + fmtTime(iso);
  return h("div", { class: "event" },
    h("span", { class: "t", text: showDay ? fmtDay(iso).slice(0, 6) : fmtTime(iso) }),
    h("span", { class: "kind " + (late ? "late" : e.kind), text: label }),
    h("div", { class: "what" }, h("div", null, (l.itemNames || []).join(", ")), h("div", { class: "sub", text: sub })),
    acts);
}
function block(title, list, mapper, emptyText) {
  const sec = h("section", { class: "section" }, h("div", { class: "section-head" }, h("h2", { text: title }), h("span", { class: "count", text: String(list.length) })));
  if (!list.length) sec.append(h("p", { class: "muted small", style: "margin:0", text: emptyText }));
  else sec.append(h("div", { class: "panel rows" }, list.map(mapper)));
  return sec;
}

// ---------------- views ----------------
function todayView() {
  let box;
  return {
    mount(root) {
      box = h("div", { class: "section" });
      root.append(h("div", { class: "toolbar", style: "justify-content:space-between" },
        h("div", null, h("h2", { text: "Today" }), h("span", { class: "muted small", text: fmtDay(nowIso()) })),
        h("button", { class: "btn btn-primary", type: "button", onclick: () => openLoanForm(null), text: "New reservation" })), box);
    },
    update() {
      box.textContent = "";
      if (!S.loaded.loans) { box.append(loading()); return; }
      const needs = needsAction().sort((a, b) => ts(a.pickupAt) - ts(b.pickupAt));
      const t0 = startOfDay(Date.now()), t1 = t0 + DAY, t2 = t1 + DAY, t8 = t0 + 8 * DAY;
      const today = eventsBetween(Date.now() - S.settings.noShowWaitMinutes * MIN, t1).filter((e) => !(e.l.status === "booked" && loanState(e.l) === "missed" && e.kind === "out") && !(e.kind === "back" && loanState(e.l) === "overdue"));
      const tomorrow = eventsBetween(t1, t2), week = eventsBetween(t2, t8);
      const open = liveLoans().filter(isOpen);
      const missingErez = liveLoans().filter((l) => {
        const e = l.erez || {};
        return (isOpen(l) && !e.reservation) || (l.status === "out" && !e.loan) || (l.status === "returned" && !e.return && Date.now() - ts(l.closedAt) < 7 * DAY);
      });
      box.append(h("div", { class: "summary" },
        h("div", { class: "stat" + (needs.length ? " hot" : "") }, h("div", { class: "v", text: String(needs.length) }), h("div", { class: "label", text: "Needs action" })),
        h("div", { class: "stat" }, h("div", { class: "v", text: String(today.length) }), h("div", { class: "label", text: "Still today" })),
        h("div", { class: "stat" }, h("div", { class: "v", text: String(open.filter((l) => l.status === "out").length) }), h("div", { class: "label", text: "Out now" })),
        h("div", { class: "stat" + (missingErez.length ? " warnish" : "") }, h("div", { class: "v", text: String(missingErez.length) }), h("div", { class: "label", text: "Not in eRezLife" }))));
      if (needs.length) box.append(block("Needs action", needs, (l) => evRow({ kind: "late", l }), ""));
      box.append(block("Still today", today, (e) => evRow(e, false), "Nothing else scheduled today."));
      box.append(block("Tomorrow", tomorrow, (e) => evRow(e, false), "Nothing scheduled tomorrow."));
      box.append(block("Next 7 days", week, (e) => evRow(e, true), "Nothing else this week."));
      if (missingErez.length) box.append(h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h2", { text: "Not yet in eRezLife" }), h("span", { class: "count", text: String(missingErez.length) })),
        h("p", { class: "muted small", style: "margin:0", text: "Tick each step once it's logged in eRezLife, so it's updated the same day." }),
        h("div", { class: "list" }, missingErez.map(loanCard))));
    },
  };
}

function calendarView() {
  let grid, dayBox, title;
  const firstOfMonth = (d) => { const x = new Date(d); x.setDate(1); x.setHours(0, 0, 0, 0); return x; };
  return {
    mount(root) {
      if (!S.calMonth) S.calMonth = firstOfMonth(new Date()).getTime();
      if (!S.calDay) S.calDay = startOfDay(Date.now());
      title = h("h2");
      const nav = (delta) => () => { const d = new Date(S.calMonth); d.setMonth(d.getMonth() + delta); S.calMonth = d.getTime(); this.update(); };
      grid = h("div", { class: "cal" });
      dayBox = h("div");
      root.append(
        h("div", { class: "toolbar", style: "justify-content:space-between" }, title,
          h("div", { class: "toolbar" },
            h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: nav(-1), "aria-label": "Previous month", text: "←" }),
            h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "Today", onclick: () => { S.calMonth = firstOfMonth(new Date()).getTime(); S.calDay = startOfDay(Date.now()); this.update(); } }),
            h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: nav(1), "aria-label": "Next month", text: "→" }))),
        h("div", { class: "cal-scroll" }, grid), dayBox);
    },
    update() {
      const m = new Date(S.calMonth);
      title.textContent = MONTH[m.getMonth()] + " " + m.getFullYear();
      grid.textContent = "";
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d) => grid.append(h("div", { class: "cal-h", text: d })));
      const start = new Date(m); start.setDate(1 - ((m.getDay() + 6) % 7));
      const all = eventsBetween(start.getTime(), start.getTime() + 42 * DAY);
      const closed = liveLoans().filter((l) => !isOpen(l));
      for (let i = 0; i < 42; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const t = d.getTime();
        const evs = all.filter((e) => startOfDay(ts(e.at)) === t);
        const outs = evs.filter((e) => e.kind === "out").length, backs = evs.length - outs;
        const late = evs.filter((e) => ["missed", "overdue"].includes(loanState(e.l)) && ts(e.at) < Date.now()).length;
        const cell = h("button", {
          class: "cal-d" + (d.getMonth() !== m.getMonth() ? " other" : "") + (t === startOfDay(Date.now()) ? " today" : "") + (t === S.calDay ? " sel" : ""),
          type: "button", "aria-label": fmtDay(d.toISOString()) + ": " + outs + " pickups, " + backs + " returns",
          onclick: () => { S.calDay = t; this.update(); },
        }, h("span", { class: "n", text: String(d.getDate()) }),
          outs ? h("span", { class: "dot-row out", text: outs + " pickup" + (outs > 1 ? "s" : "") }) : null,
          backs ? h("span", { class: "dot-row back" + (late ? " late" : ""), text: backs + " return" + (backs > 1 ? "s" : "") }) : null);
        grid.append(cell);
      }
      dayBox.textContent = "";
      const evs = eventsBetween(S.calDay, S.calDay + DAY);
      const done = closed.filter((l) => startOfDay(ts(l.closedAt || l.returnAt)) === S.calDay);
      dayBox.append(block(fmtDay(new Date(S.calDay).toISOString()), evs, (e) => evRow(e, false), "No pickups or returns scheduled."));
      if (done.length) dayBox.append(h("p", { class: "muted small", text: "Closed that day: " + done.map((l) => (l.itemNames || []).join(", ") + " (" + LOAN_LABEL[l.status] + ")").join("; ") }));
    },
  };
}

function loansView() {
  let box, chips;
  const FILTERS = [["active", "Active"], ["needs", "Needs action"], ["closed", "Closed"], ["all", "All"]];
  return {
    mount(root) {
      chips = h("div", { class: "chips" });
      box = h("div", { class: "list" });
      const search = h("input", { type: "search", id: "loan-search", placeholder: "Search name, matriculation number or item", "aria-label": "Search loans", value: S.q.loans });
      search.addEventListener("input", () => { S.q.loans = search.value; this.update(); });
      root.append(h("div", { class: "toolbar", style: "justify-content:space-between" }, h("h2", { text: "Loans" }), h("button", { class: "btn btn-primary", type: "button", onclick: () => openLoanForm(null), text: "New reservation" })),
        h("div", { class: "toolbar" }, search, chips), box);
    },
    update() {
      const all = liveLoans();
      const groups = { active: all.filter(isOpen), needs: needsAction(), closed: all.filter((l) => !isOpen(l)), all };
      chips.textContent = "";
      FILTERS.forEach(([k, label]) => chips.append(h("button", { class: "chip", type: "button", "aria-pressed": String(S.loanFilter === k), onclick: () => { S.loanFilter = k; this.update(); } }, label, h("span", { class: "n", text: String(groups[k].length) }))));
      box.textContent = "";
      if (!S.loaded.loans) { box.append(loading()); return; }
      const q = lc(S.q.loans);
      let list = groups[S.loanFilter].filter((l) => !q || [l.borrowerName, l.matric, ...(l.itemNames || [])].some((v) => lc(v).includes(q)));
      list = ["closed", "all"].includes(S.loanFilter) ? list.sort((a, b) => ts(b.pickupAt) - ts(a.pickupAt))
        : list.sort((a, b) => ts(a.status === "booked" ? a.pickupAt : a.returnAt) - ts(b.status === "booked" ? b.pickupAt : b.returnAt));
      if (!list.length) { box.append(all.length ? empty("Nothing matches", "Try another filter or search.") : empty("No loans yet", "Press “New reservation” to add the first one.")); return; }
      list.forEach((l) => box.append(loanCard(l)));
    },
  };
}

function itemsView() {
  let box, chips, pudoSel;
  return {
    mount(root) {
      chips = h("div", { class: "chips" });
      box = h("div");
      const search = h("input", { type: "search", id: "item-search", placeholder: "Search name, tag or category", "aria-label": "Search inventory", value: S.q.items });
      search.addEventListener("input", () => { S.q.items = search.value; this.update(); });
      pudoSel = h("select", { id: "item-pudo", "aria-label": "PUDO point", style: "width:auto" }, h("option", { value: "all", text: "All PUDO points" }), pudos().map((p) => h("option", { value: p.id, text: p.room + " · " + p.building })));
      pudoSel.value = S.itemPudo;
      pudoSel.addEventListener("change", () => { S.itemPudo = pudoSel.value; this.update(); });
      root.append(h("div", { class: "toolbar", style: "justify-content:space-between" }, h("h2", { text: "Inventory" }), h("button", { class: "btn btn-primary", type: "button", onclick: () => openItemForm(null), text: "Add item" })),
        h("div", { class: "toolbar" }, search, pudoSel), chips, box);
    },
    update() {
      const rows = S.items.filter((it) => S.itemPudo === "all" || it.pudo === S.itemPudo).map((it) => ({ it, st: itemState(it) }));
      const bucket = (k) => (k === "overdue" ? "out" : k);
      const counts = { all: rows.length, ready: 0, out: 0, broken: 0, missing: 0 };
      rows.forEach((r) => counts[bucket(r.st.kind)]++);
      chips.textContent = "";
      [["all", "All"], ["ready", "On the shelf"], ["out", "Lent out"], ["broken", "Broken"], ["missing", "Missing"]].forEach(([k, label]) =>
        chips.append(h("button", { class: "chip", type: "button", "aria-pressed": String(S.itemFilter === k), onclick: () => { S.itemFilter = k; this.update(); } }, label, h("span", { class: "n", text: String(counts[k]) }))));
      box.textContent = "";
      if (!S.loaded.items) { box.append(loading()); return; }
      if (!S.items.length) { box.append(empty("The inventory is empty", "Press “Add item” for each thing you lend. Give identical items their own tag (V-01, V-02…) and set the PUDO point that stocks it.")); return; }
      const q = lc(S.q.items);
      const shown = rows.filter((r) => S.itemFilter === "all" || bucket(r.st.kind) === S.itemFilter)
        .filter((r) => !q || [r.it.name, r.it.tag, r.it.category].some((v) => lc(v).includes(q)))
        .sort((a, b) => (pudoShort(a.it.pudo) + itemLabel(a.it)).localeCompare(pudoShort(b.it.pudo) + itemLabel(b.it)));
      if (!shown.length) { box.append(empty("Nothing matches", "Try another filter or search.")); return; }
      box.append(h("div", { class: "panel rows" }, shown.map(({ it, st }) => {
        let detail = "";
        if (st.loan && (st.kind === "out" || st.kind === "overdue")) detail = "With " + st.loan.borrowerName + " · back " + fmtFull(st.loan.returnAt) + " (" + rel(st.loan.returnAt) + ")";
        else if (st.loan) detail = "Next booking: " + st.loan.borrowerName + " · " + fmtFull(st.loan.pickupAt);
        else if (it.conditionNote && (st.kind === "broken" || st.kind === "missing")) detail = it.conditionNote;
        const cond = conditionSelect("cond-" + it.id, it.condition);
        cond.setAttribute("aria-label", "Condition of " + itemLabel(it));
        cond.addEventListener("change", async () => {
          cond.disabled = true;
          try { await api.update("items", it.id, { condition: cond.value, conditionNote: cond.value === "ok" ? "" : it.conditionNote || "", conditionAt: nowIso(), conditionBy: meRef() }); toast(itemLabel(it) + " marked " + (cond.value === "ok" ? "OK" : cond.value) + "."); }
          catch (e) { toast(errText(e), true); cond.disabled = false; }
        });
        const acts = h("div", { class: "acts" }, cond);
        if (st.kind === "ready") acts.append(h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => openLoanForm(null, { itemId: it.id, pudo: it.pudo }), text: "Reserve" }));
        acts.append(h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openItemForm(it), text: "Edit" }));
        return h("div", { class: "row" },
          h("div", null, h("h3", null, it.name, it.tag ? h("span", { class: "tag", style: "margin-left:8px", text: it.tag }) : null),
            h("div", { class: "sub" }, h("span", { text: pudoLabel(it.pudo) }), it.category ? h("span", { text: it.category }) : null,
              h("span", { text: Number(it.replacementValue) > 0 ? "Value " + euro(Number(it.replacementValue)) : "Value unknown" }), it.notes ? h("span", { text: it.notes }) : null)),
          h("div", { style: "display:grid;gap:3px" }, h("span", { class: "pill " + st.kind, style: "justify-self:start", text: ITEM_LABEL[st.kind] }), detail ? h("span", { class: "muted small", text: detail }) : null),
          acts);
      })));
    },
  };
}

function openItemForm(it) {
  const name = h("input", { id: "i-name", placeholder: "e.g. Vacuum", value: it ? it.name : "" });
  const tag = h("input", { id: "i-tag", placeholder: "e.g. V-05", value: it ? it.tag || "" : "" });
  const cat = h("input", { id: "i-cat", placeholder: "e.g. Cleaning", list: "cat-list", value: it ? it.category || "" : "" });
  const cats = h("datalist", { id: "cat-list" }, [...new Set(S.items.map((i) => i.category).filter(Boolean))].map((c) => h("option", { value: c })));
  const pudo = pudoSelect("i-pudo", it ? it.pudo : S.itemPudo !== "all" ? S.itemPudo : undefined, true);
  const value = h("input", { id: "i-value", type: "number", min: "0", step: "0.01", placeholder: "Leave empty if unknown", value: it && it.replacementValue ? String(it.replacementValue) : "" });
  const notes = h("textarea", { id: "i-notes", rows: 2, placeholder: "What's included, e.g. 16 balls + 2 cues", value: it ? it.notes || "" : "" });
  const condNote = h("input", { id: "i-cnote", placeholder: "What's wrong with it", value: it ? it.conditionNote || "" : "" });
  const body = [h("div", { class: "grid3" }, field("Item name", name), field("Tag / ID", tag), field("Category", cat)), cats,
    h("div", { class: "grid2" }, field("PUDO point (where it's stocked)", pudo), field("Replacement value (€)", value, "From the catalogue at the TSO. Caps the late fee.")),
    field("What's included / notes", notes)];
  if (it && it.condition && it.condition !== "ok") body.push(field("Condition note", condNote));
  if (it && isSup()) {
    const inUse = liveLoans().some((l) => isOpen(l) && (l.itemIds || []).includes(it.id));
    body.push(h("div", { class: "toolbar" }, inUse ? h("span", { class: "muted small", text: "In an active loan, so it can't be removed yet." })
      : armedButton("delitem:" + it.id, "Remove from inventory", "Confirm remove", async () => { await api.remove("items", it.id); dlg.close(); toast("Item removed."); })));
  }
  openDialog(it ? "Edit item" : "Add item", body, {
    submitLabel: it ? "Save item" : "Add item",
    onSubmit: async () => {
      if (!norm(name.value)) return "Give the item a name.";
      const t = norm(tag.value);
      if (t && S.items.some((x) => x.id !== (it && it.id) && lc(x.tag) === lc(t))) return "Another item already has the tag " + t + ".";
      if (it && pudo.value !== it.pudo && liveLoans().some((l) => isOpen(l) && (l.itemIds || []).includes(it.id))) return "Can't move it to another PUDO point while it's reserved or lent out.";
      const v = norm(value.value) === "" ? null : Number(value.value);
      if (v !== null && !(v >= 0)) return "The replacement value must be a number.";
      const data = { name: norm(name.value), tag: t, category: norm(cat.value), pudo: pudo.value, replacementValue: v, notes: norm(notes.value) };
      if (it) { if (it.condition && it.condition !== "ok") data.conditionNote = norm(condNote.value); await api.update("items", it.id, data); toast("Item saved."); }
      else { await api.add("items", { ...data, condition: "ok", createdAt: nowIso(), createdBy: meRef() }); toast(itemLabel(data) + " added."); }
    },
  });
}

function borrowersView() {
  let box;
  return {
    mount(root) {
      box = h("div");
      const search = h("input", { type: "search", id: "bor-search", placeholder: "Search name or matriculation number", "aria-label": "Search borrowers", value: S.q.borrowers });
      search.addEventListener("input", () => { S.q.borrowers = search.value; this.update(); });
      root.append(h("div", { class: "toolbar", style: "justify-content:space-between" }, h("h2", { text: "Borrowers" }),
        h("button", { class: "btn btn-ghost", type: "button", onclick: () => openNewBorrower(), text: "Add student" })), h("div", { class: "toolbar" }, search), box);
    },
    update() {
      box.textContent = "";
      if (!S.loaded.borrowers) { box.append(loading()); return; }
      if (!S.borrowers.length) { box.append(empty("No students yet", "Students are added the first time you reserve for them. Use “Add student” to record a Contract Amendment in advance.")); return; }
      const q = lc(S.q.borrowers);
      const rank = { banned: 0, suspended: 1, noshows: 2, ok: 3, new: 4 };
      const list = S.borrowers.map((b) => ({ b, st: borrowerState(b) }))
        .filter(({ b }) => !q || lc(b.name).includes(q) || b.id.includes(q))
        .sort((x, y) => rank[x.st.kind] - rank[y.st.kind] || lc(x.b.name).localeCompare(lc(y.b.name)));
      if (!list.length) { box.append(empty("Nothing matches", "Try another search.")); return; }
      box.append(h("div", { class: "panel rows" }, list.map(({ b, st }) => {
        const loans = liveLoans().filter((l) => l.matric === b.id);
        const v = (b.violations || []).length;
        return h("div", { class: "row" },
          h("div", null, h("h3", { text: b.name || "(no name)" }), h("div", { class: "sub" }, h("span", { class: "mono", text: b.id }),
            h("span", { text: loans.length + " loan" + (loans.length === 1 ? "" : "s") }),
            h("span", { text: b.contract ? "Contract on file" : "No contract on file" }),
            v ? h("span", { text: v + " violation" + (v === 1 ? "" : "s") }) : null)),
          h("div", null, borrowerPill(st)),
          h("div", { class: "acts" }, h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openBorrower(b.id), text: "Open" })));
      })));
    },
  };
}

function openNewBorrower() {
  const matric = h("input", { id: "nb-matric", inputmode: "numeric", placeholder: "e.g. 30009280" });
  const name = h("input", { id: "nb-name" });
  const contract = check("nb-contract", "Signed Contract Amendment is on file", true);
  openDialog("Add student", [h("div", { class: "grid2" }, field("Matriculation number", matric), field("Name", name)), h("div", { class: "checks" }, contract.el)], {
    submitLabel: "Add",
    onSubmit: async () => {
      const m = norm(matric.value).replace(/\s+/g, "");
      if (!/^\d{5,12}$/.test(m)) return "Enter the matriculation number (digits only).";
      if (!norm(name.value)) return "Enter the name.";
      if (borrowerOf(m)) return "This student is already listed.";
      await api.set("borrowers", m, { matric: m, name: norm(name.value), noShows: [], violations: [], suspensions: [], ...(contract.input.checked ? { contract: { at: nowIso(), by: meRef() } } : {}) });
      toast("Added.");
    },
  });
}

function openBorrower(matric) {
  const b = borrowerOf(matric);
  if (!b) return;
  const st = borrowerState(b);
  const name = h("input", { id: "b-name", value: b.name || "" });
  const loans = liveLoans().filter((l) => l.matric === matric).sort((x, y) => ts(y.pickupAt) - ts(x.pickupAt));
  const listOrNone = (arr, fn, none) => arr.length ? h("div", { class: "history" }, arr.map(fn)) : h("span", { class: "muted small", text: none });
  const counting = new Set(countingNoShows(b).map((n) => n.at));
  const body = [
    h("div", { class: "toolbar" }, borrowerPill(st), h("span", { class: "mono muted", text: matric })),
    st.s ? h("div", { class: "banner bad", text: (st.kind === "banned" ? "Permanently banned" : "Suspended until " + fmtFull(st.s.until)) + " · " + st.s.reason + " · by " + (st.s.by ? st.s.by.name : "") }) : null,
    field("Name", name),
    h("section", { class: "section" }, h("span", { class: "label", text: "Contract Amendment" }),
      b.contract ? h("span", { text: "On file, recorded " + fmtDate(b.contract.at) + " by " + b.contract.by.name })
        : h("div", { class: "toolbar" }, h("span", { class: "muted", text: "Not on file." }), h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "Mark as signed", onclick: async () => { await api.update("borrowers", matric, { contract: { at: nowIso(), by: meRef() } }); dlg.close(); toast("Contract Amendment recorded."); } }))),
    h("section", { class: "section" }, h("span", { class: "label", text: "No-shows (" + counting.size + " of " + S.settings.noShowLimit + " toward a suspension)" }),
      listOrNone((b.noShows || []).slice().reverse(), (n) => h("div", null,
        h("span", null, fmtFull(n.at) + (n.items ? " · " + n.items : "") + (n.by ? " · " + n.by.name : ""), counting.has(n.at) ? null : h("span", { class: "muted", text: " (before last suspension)" })),
        isSup() ? armedButton("ns:" + matric + n.at, "Remove", "Confirm remove", async () => { await api.update("borrowers", matric, { noShows: (b.noShows || []).filter((x) => x.at !== n.at) }); dlg.close(); toast("No-show removed."); }) : null), "No no-shows.")),
    h("section", { class: "section" }, h("span", { class: "label", text: "Violations (late, dirty, damaged, not returned)" }),
      listOrNone((b.violations || []).slice().reverse(), (v) => h("div", null, h("span", { text: fmtDay(v.at) + " · " + (v.types || []).join(", ") + (v.items ? " · " + v.items : "") + (v.lateDays ? " · " + v.lateDays + " day(s) late, up to " + euro(v.fee) : "") + (v.note ? " · " + v.note : "") })), "None. Rule 16: repeated violations can lead to a suspension; the Housing Team decides.")),
  ];
  if (isSup()) {
    const tools = h("div", { class: "toolbar" });
    if (st.s) {
      tools.append(h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "Lift " + (st.kind === "banned" ? "ban" : "suspension"), onclick: async () => {
        await api.update("borrowers", matric, { suspensions: (b.suspensions || []).map((s) => (s === st.s || (s.from === st.s.from && s.type === st.s.type) ? { ...s, liftedAt: nowIso(), liftedBy: meRef() } : s)) });
        await notifyHousing("Lending Library: " + (st.kind === "banned" ? "ban" : "suspension") + " lifted for " + b.name + " (" + matric + ")", ["Lifted by " + meRef().name + "."]);
        dlg.close(); toast("Lifted.");
      } }));
    } else {
      const type = h("select", { id: "b-type", style: "width:auto" }, h("option", { value: "suspension", text: "Suspension" }), h("option", { value: "permanent", text: "Permanent ban" }));
      const months = h("select", { id: "b-months", style: "width:auto" }, [1, 2, 3].map((m) => h("option", { value: String(m), text: m + " month" + (m > 1 ? "s" : "") })));
      months.value = "3";
      type.addEventListener("change", () => { months.hidden = type.value === "permanent"; });
      const why = h("input", { id: "b-why", placeholder: "Reason (e.g. repeated late returns, Rule 16)" });
      tools.append(type, months, why, h("button", { class: "btn btn-danger btn-sm", type: "button", text: "Apply", onclick: async () => {
        if (!norm(why.value)) { why.focus(); return; }
        const s = { type: type.value, from: nowIso(), until: type.value === "permanent" ? null : new Date(Date.now() + Number(months.value) * 30 * DAY).toISOString(), reason: norm(why.value), auto: false, by: meRef() };
        await api.update("borrowers", matric, { suspensions: [...(b.suspensions || []), s] });
        await notifyHousing("Lending Library: " + (s.type === "permanent" ? "permanent ban" : "suspension") + " for " + b.name + " (" + matric + ")", [
          s.type === "permanent" ? "Permanently banned." : "Suspended until " + fmtFull(s.until) + ".", "Reason: " + s.reason, "By " + meRef().name + "."]);
        dlg.close(); toast("Applied. The Housing Team will be emailed.");
      } }));
    }
    body.push(h("section", { class: "section" }, h("span", { class: "label", text: "Suspension or ban (supervisors)" }), tools));
  }
  body.push(h("section", { class: "section" }, h("span", { class: "label", text: "Loan history" }),
    listOrNone(loans, (l) => h("div", null, h("span", { text: fmtDay(l.pickupAt) + " · " + (l.itemNames || []).join(", ") + " · " + pudoShort(l.pudo) }), h("span", { class: "pill " + loanState(l), text: LOAN_LABEL[loanState(l)] })), "No loans.")));
  openDialog(b.name || matric, body, {
    wide: true, submitLabel: "Save name",
    onSubmit: async () => { if (!norm(name.value)) return "Name can't be empty."; await api.update("borrowers", matric, { name: norm(name.value) }); toast("Saved."); },
  });
}

// Exports shaped for the Teams spreadsheets
function logsView() {
  let box, tabs;
  const LOGS = {
    noshows: {
      title: "No-Show Log",
      head: ["Date", "Time", "Student name", "Matriculation number", "Item(s)", "PUDO point", "Logged by", "No-shows in total"],
      rows: () => S.borrowers.flatMap((b) => (b.noShows || []).map((n, i) => [fmtDate(n.at), fmtTime(n.at), b.name, b.id, n.items || "", pudoShort(n.pudo), n.by ? n.by.name : "", i + 1])).sort((a, b) => (b[0].split(".").reverse().join("") + b[1]).localeCompare(a[0].split(".").reverse().join("") + a[1])),
    },
    suspensions: {
      title: "Suspension/Ban List",
      head: ["Student name", "Matriculation number", "Type", "From", "Until", "Reason", "Applied by", "Status"],
      rows: () => S.borrowers.flatMap((b) => (b.suspensions || []).map((s) => [b.name, b.id, s.type === "permanent" ? "Permanent ban" : "Suspension", fmtDate(s.from), s.until ? fmtDate(s.until) : "—", s.reason, s.by ? s.by.name : "",
        s.liftedAt ? "Lifted " + fmtDate(s.liftedAt) : !s.until || ts(s.until) > Date.now() ? "Active" : "Ended"])),
    },
    contacts: {
      title: "No-Return Contact Log",
      head: ["Date", "Time", "Student name", "Matriculation number", "Item(s)", "Due date", "Attempt", "How", "Contacted by", "Note"],
      rows: () => liveLoans().flatMap((l) => (l.contacts || []).map((c, i) => [fmtDate(c.at), fmtTime(c.at), l.borrowerName, l.matric, (l.itemNames || []).join(", "), fmtDate(l.returnAt), i + 1, c.method, c.by ? c.by.name : "", c.note || ""])),
    },
    violations: {
      title: "Escalations to Housing",
      head: ["Date", "Student name", "Matriculation number", "Item(s)", "Type", "Days late", "Late fee up to (€)", "Note", "Logged by"],
      rows: () => S.borrowers.flatMap((b) => (b.violations || []).map((v) => [fmtDate(v.at), b.name, b.id, v.items || "", (v.types || []).join(", "), v.lateDays || "", v.fee || "", v.note || "", v.by ? v.by.name : ""])),
    },
  };
  return {
    mount(root) {
      tabs = h("div", { class: "chips" });
      box = h("div", { class: "section" });
      root.append(h("h2", { text: "Logs" }),
        h("p", { class: "muted small", style: "margin:0;max-width:70ch", text: "These mirror the spreadsheets in the Teams folder. While you keep both, use “Copy for Excel” and paste the new rows into the spreadsheet." }),
        tabs, box);
    },
    update() {
      tabs.textContent = "";
      Object.entries(LOGS).forEach(([k, d]) => tabs.append(h("button", { class: "chip", type: "button", "aria-pressed": String(S.logTab === k), onclick: () => { S.logTab = k; this.update(); }, text: d.title })));
      const d = LOGS[S.logTab];
      const rows = d.rows();
      box.textContent = "";
      box.append(h("div", { class: "toolbar" },
        h("button", { class: "btn btn-primary btn-sm", type: "button", text: "Copy for Excel", disabled: !rows.length, onclick: () => copyText([d.head, ...rows].map((r) => r.join("\t")).join("\n")) }),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "Download CSV", disabled: !rows.length, onclick: () => downloadCsv(d.title.replace(/[^\w]+/g, "-") + ".csv", [d.head, ...rows]) }),
        h("span", { class: "muted small", text: rows.length + " row" + (rows.length === 1 ? "" : "s") })));
      if (!rows.length) { box.append(empty("Nothing logged yet", "Entries appear here as you use the site.")); return; }
      box.append(h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, d.head.map((c) => h("th", { text: c })))),
        h("tbody", null, rows.map((r) => h("tr", null, r.map((c) => h("td", { text: String(c) }))))))));
    },
  };
}

function settingsView() {
  let staffBox, syncBox;
  return {
    mount(root) {
      staffBox = h("div"); syncBox = h("div");
      const s = S.settings;
      const pudoRows = pudos().map((p) => ({ p, active: h("input", { type: "checkbox", id: "pa-" + p.id, checked: !!p.active }) }));
      const num = (id, v, min = 0) => h("input", { id, type: "number", min: String(min), value: String(v) });
      const f = {
        itemLimit: num("s-limit", s.itemLimit, 1), loanDays: num("s-loan", s.loanDays, 1), extensionDays: num("s-ext", s.extensionDays, 0),
        noShowLimit: num("s-ns", s.noShowLimit, 1), suspensionDays: num("s-susp", s.suspensionDays, 1), noShowWaitMinutes: num("s-wait", s.noShowWaitMinutes, 0),
        lateFeePerDay: num("s-fee", s.lateFeePerDay, 0), contactAttempts: num("s-contact", s.contactAttempts, 1), retentionMonths: num("s-ret", s.retentionMonths, 1),
      };
      const advance = h("select", { id: "s-adv" }, h("option", { value: "warn", text: "SAs can make exceptions with a reason" }), h("option", { value: "strict", text: "Only supervisors can make exceptions" }));
      advance.value = s.advanceRule;
      const notify = h("input", { id: "s-mail", type: "email", placeholder: "housing@…", value: s.notifyEmail || "" });
      const escal = h("input", { id: "s-esc", type: "email", placeholder: "Leave empty to use the Housing mailbox", value: s.escalationEmail || "" });
      const er = check("s-er", "Send reminder emails", s.emailReminders !== false), tr = check("s-tr", "Post reminders in Teams", s.teamsReminders !== false);
      const msg = h("span", { class: "ok-msg", role: "status" });
      const save = h("button", { class: "btn btn-primary", type: "submit", text: "Save settings" });
      const form = h("form", { class: "panel", style: "padding:16px;display:grid;gap:14px", novalidate: true },
        h("h2", { text: "PUDO points" }),
        h("div", { class: "checks" }, pudoRows.map(({ p, active }) => h("label", { class: "check", for: active.id }, active, h("span", null, p.room + " · " + p.building)))),
        h("p", { class: "muted small", style: "margin:0", text: "Untick a point to hide it when reserving (for example Krupp E–F until it opens)." }),
        h("h2", { text: "Lending rules" }),
        h("div", { class: "grid3" }, field("Item limit per student", f.itemLimit), field("Loan period (days)", f.loanDays), field("Extension (days)", f.extensionDays)),
        h("div", { class: "grid3" }, field("No-shows before suspension", f.noShowLimit), field("Suspension length (days)", f.suspensionDays), field("Wait before no-show (min)", f.noShowWaitMinutes)),
        h("div", { class: "grid3" }, field("Late fee per day (€)", f.lateFeePerDay), field("Contact attempts before escalating", f.contactAttempts), field("Delete closed loans after (months)", f.retentionMonths)),
        field("24-hour rule exceptions", advance),
        h("h2", { text: "Notifications" }),
        h("div", { class: "grid2" }, field("Housing mailbox (reminders and morning summary)", notify), field("Housing Team (escalations and suspensions)", escal)),
        h("div", { class: "checks" }, er.el, tr.el),
        h("p", { class: "muted small", style: "margin:0", text: "The Teams channel link is set in the reminder script, not here (see SETUP.md)." }),
        h("div", { class: "toolbar" }, save, msg));
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = { pudos: pudoRows.map(({ p, active }) => ({ ...p, active: active.checked })), advanceRule: advance.value, notifyEmail: lc(notify.value), escalationEmail: lc(escal.value), emailReminders: er.input.checked, teamsReminders: tr.input.checked };
        for (const [k, el] of Object.entries(f)) { const n = Number(el.value); if (!(n >= Number(el.min))) { msg.className = "err"; msg.textContent = "Check the numbers."; el.focus(); return; } data[k] = n; }
        const bad = [data.notifyEmail, data.escalationEmail].find((m) => m && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m));
        if (bad) { msg.className = "err"; msg.textContent = bad + " doesn't look like an email address."; return; }
        if (!data.pudos.some((p) => p.active)) { msg.className = "err"; msg.textContent = "Keep at least one PUDO point active."; return; }
        save.disabled = true;
        try { await api.set("settings", "main", data); msg.className = "ok-msg"; msg.textContent = "Saved."; }
        catch (err) { msg.className = "err"; msg.textContent = errText(err); }
        finally { save.disabled = false; }
      });
      root.append(h("h2", { text: "Settings" }), syncBox, staffBox, form);
    },
    update() {
      syncBox.textContent = "";
      const sent = S.loans.flatMap((l) => Object.values(l.remind || {})).filter(Boolean).sort().pop();
      syncBox.append(h("div", { class: "banner " + (S.settings.notifyEmail ? "info" : "warn") },
        S.settings.notifyEmail ? "Reminders go to " + S.settings.notifyEmail + ". " : "No Housing mailbox set yet, so no reminders are sent. Add it below. ",
        sent ? "Last reminder sent " + rel(sent) + "." : "No reminders sent yet."));
      staffBox.textContent = "";
      const email = h("input", { id: "st-email", type: "email", placeholder: "Their university email" });
      const name = h("input", { id: "st-name", placeholder: "Name" });
      const role = h("select", { id: "st-role" }, h("option", { value: "sa", text: "Student Assistant" }), h("option", { value: "supervisor", text: "Supervisor" }));
      const add = h("button", { class: "btn btn-primary btn-sm", type: "button", text: "Give access", onclick: async () => {
        const e = lc(email.value);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { email.focus(); toast("Enter a valid email address.", true); return; }
        if (!norm(name.value)) { name.focus(); toast("Enter their name.", true); return; }
        try { await api.set("staff", e, { email: e, name: norm(name.value), role: role.value, active: true, addedAt: nowIso(), addedBy: meRef() }); toast(norm(name.value) + " can now create an account with " + e + "."); email.value = ""; name.value = ""; }
        catch (err) { toast(errText(err), true); }
      } });
      const rows = S.staff.slice().sort((a, b) => (a.role === b.role ? lc(a.name).localeCompare(lc(b.name)) : a.role === "supervisor" ? -1 : 1)).map((s) => {
        const sel = h("select", { "aria-label": "Role of " + (s.name || s.id) }, h("option", { value: "sa", text: "Student Assistant" }), h("option", { value: "supervisor", text: "Supervisor" }));
        sel.value = s.role || "sa";
        const self = s.id === S.user.email;
        sel.disabled = self;
        sel.addEventListener("change", () => api.update("staff", s.id, { role: sel.value }).then(() => toast("Role updated.")).catch((e) => toast(errText(e), true)));
        return h("div", { class: "row" },
          h("div", null, h("h3", { text: (s.name || s.id) + (self ? " (you)" : "") }), h("div", { class: "sub", text: s.id })),
          h("div", null, sel),
          h("div", { class: "acts" }, self ? null : armedButton("staff:" + s.id, "Remove access", "Confirm remove", () => api.remove("staff", s.id).then(() => toast("Access removed.")))));
      });
      staffBox.append(h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h2", { text: "Staff with access" }), h("span", { class: "count", text: String(S.staff.length) })),
        h("p", { class: "muted small", style: "margin:0;max-width:70ch", text: "Add someone's university email here first. They then open the site, choose “Create account” with that email and confirm it from their inbox. Supervisors can manage staff, settings, suspensions and deletions. Changes to the website itself are made on GitHub." }),
        h("div", { class: "panel rows" }, rows),
        h("div", { class: "panel", style: "padding:12px;display:grid;gap:10px" }, h("div", { class: "grid3" }, field("University email", email), field("Name", name), field("Role", role)), h("div", null, add))));
    },
  };
}

// ---------------- sign-in screens ----------------
function gate(title, text, ...content) {
  app.textContent = "";
  app.append(h("div", { class: "gate" }, h("h1", null, "Lending ", h("span", { text: "Library" })), h("h2", { text: title }), text ? h("p", { class: "muted", text }) : null, ...content));
}
function renderSignIn(mode = "in", note = "") {
  const email = h("input", { id: "a-email", type: "email", autocomplete: "username", placeholder: "you@university email" });
  const pw = h("input", { id: "a-pw", type: "password", autocomplete: mode === "up" ? "new-password" : "current-password", placeholder: mode === "up" ? "At least 8 characters" : "" });
  const err = h("p", { class: "err", role: "alert", text: "" });
  const ok = h("p", { class: "ok-msg", role: "status", text: note });
  const submit = h("button", { class: "btn btn-primary", type: "submit", text: mode === "up" ? "Create account" : "Sign in" });
  const form = h("form", { class: "panel", style: "padding:18px;display:grid;gap:12px;text-align:left", novalidate: true },
    field("University email", email), field("Password", pw), err, ok, submit,
    h("div", { class: "toolbar", style: "justify-content:space-between" },
      h("button", { class: "linkish", type: "button", text: mode === "up" ? "I already have an account" : "First time? Create an account", onclick: () => renderSignIn(mode === "up" ? "in" : "up") }),
      mode === "in" ? h("button", { class: "linkish", type: "button", text: "Forgot password", onclick: async () => {
        if (!email.value) { err.textContent = "Enter your email first."; return; }
        try { await api.resetPassword(lc(email.value)); ok.textContent = "If that account exists, a reset link is on its way. Check junk mail too."; } catch (e) { err.textContent = errText(e); }
      } }) : null));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.textContent = ""; submit.disabled = true;
    try {
      if (mode === "up") { if (pw.value.length < 8) { err.textContent = "Use at least 8 characters."; return; } await api.signUp(lc(email.value), pw.value); }
      else await api.signIn(lc(email.value), pw.value);
    } catch (ex) { err.textContent = errText(ex); }
    finally { submit.disabled = false; }
  });
  gate(mode === "up" ? "Create your account" : "Staff sign-in", mode === "up" ? "Use the university email a supervisor gave access to. You'll get a confirmation email." : "", form);
  email.focus();
}
function renderVerify(u) {
  const msg = h("p", { class: "muted small", role: "status" });
  gate("Confirm your email", "We sent a link to " + u.email + ". Open it (check junk mail too), then press the button below.",
    h("div", { class: "toolbar", style: "justify-content:center" },
      h("button", { class: "btn btn-primary", type: "button", text: "I've confirmed it", onclick: async () => {
        const nu = await api.refreshVerified();
        if (nu && nu.verified) start(nu); else msg.textContent = "Not confirmed yet. Open the link in the email first.";
      } }),
      h("button", { class: "btn btn-ghost", type: "button", text: "Send the email again", onclick: () => api.resendVerification().then(() => { msg.textContent = "Sent again."; }).catch((e) => { msg.textContent = errText(e); }) }),
      h("button", { class: "btn btn-ghost", type: "button", text: "Sign out", onclick: () => api.signOut() })), msg);
}

// ---------------- boot ----------------
let unsubs = [], meUnsub = null, started = false;
function stopAll() { unsubs.forEach((u) => { try { u(); } catch (e) {} }); unsubs = []; if (meUnsub) { try { meUnsub(); } catch (e) {} meUnsub = null; } started = false; views = null; mainEl = null; }

function startData() {
  views = { today: todayView(), calendar: calendarView(), loans: loansView(), items: itemsView(), borrowers: borrowersView(), logs: logsView(), settings: settingsView() };
  const fail = (what) => (err) => { console.error(what, err); toast("Couldn't load " + what + ": " + errText(err), true); };
  let firstSettings = true;
  unsubs.push(api.watch("staff", (d) => { S.staff = d; schedule(); }, fail("staff")));
  unsubs.push(api.watchDoc("settings", "main", (d) => {
    S.settings = { ...DEFAULT_SETTINGS, ...(d || {}) };
    if (firstSettings && S.view === "settings" && mainEl) go("settings");
    firstSettings = false; schedule();
  }, fail("settings")));
  unsubs.push(api.watch("items", (d) => { S.items = d; S.loaded.items = true; schedule(); }, fail("inventory")));
  unsubs.push(api.watch("borrowers", (d) => { S.borrowers = d; S.loaded.borrowers = true; schedule(); }, fail("students")));
  unsubs.push(api.watch("loans", (d) => { S.loans = d; S.loaded.loans = true; schedule(); }, fail("loans")));
  renderShell();
}
function start(u) {
  stopAll();
  S.user = u; S.me = null;
  if (!u) { renderSignIn("in"); return; }
  if (!u.verified) { renderVerify(u); return; }
  gate("Checking access…", "");
  meUnsub = api.watchDoc("staff", u.email, (doc) => {
    const prevRole = S.me && S.me.role;
    S.me = doc && doc.active !== false ? doc : null;
    if (!S.me) {
      unsubs.forEach((x) => { try { x(); } catch (e) {} }); unsubs = []; started = false; views = null; mainEl = null;
      gate("No access yet", u.email + " isn't on the staff list. Ask a supervisor to add it in Settings, then reload this page.",
        h("div", { class: "toolbar", style: "justify-content:center" }, h("button", { class: "btn btn-ghost", type: "button", text: "Sign out", onclick: () => api.signOut() })));
      return;
    }
    if (!started) { started = true; startData(); }
    else if (prevRole !== S.me.role) renderShell();
  }, () => gate("No access yet", u.email + " isn't on the staff list. Ask a supervisor to add it, then reload.",
    h("div", { class: "toolbar", style: "justify-content:center" }, h("button", { class: "btn btn-ghost", type: "button", text: "Sign out", onclick: () => api.signOut() }))));
}
async function boot() {
  const hv = (location.hash || "").slice(1);
  if (TABS.some(([k]) => k === hv)) S.view = hv;
  try { api = DEMO ? demoApi() : await firebaseApi(); }
  catch (e) { console.error(e); gate("Couldn't start", "The site couldn't reach Firebase. Check the internet connection and the settings in config.js."); return; }
  api.onUser(start);
  setInterval(() => { if (!dlg.open) schedule(); }, 60e3);
}
boot();
