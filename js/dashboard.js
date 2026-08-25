// js/dashboard.js — Gamified Dashboard
import { sb } from "./supabaseClient.js";
import { mountNav } from "./nav.js";
import { withBusy, setBusyProgress } from "./busy.js";

// -------------------- DOM --------------------
const cntNew = document.getElementById("cntNew");
const cntAction = document.getElementById("cntAction");
const cntTotal = document.getElementById("cntTotal");
const cntResolved = document.getElementById("cntResolved");

const ticketFilterPills = document.getElementById("ticketFilterPills");
const ticketLBFilter = document.getElementById("ticketLBFilter");
const entriesLBFilter = document.getElementById("entriesLBFilter");

const ticketLBList = document.getElementById("ticketLBList");
const entriesLBList = document.getElementById("entriesLBList");

const greetingText = document.getElementById("greetingText");
const greetingSub = document.getElementById("greetingSub");

// -------------------- State --------------------
let ticketRange = "week";
let ticketLBRange = "week";
let entriesLBRange = "daily";

// -------------------- Date helpers --------------------
function startOfDay(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}
function addDays(d, days) {
  const x = new Date(d); x.setDate(x.getDate() + days); return x;
}
function startOfWeekMonday(d) {
  const x = startOfDay(d);
  const day = x.getDay();
  const diff = (day + 6) % 7;
  return addDays(x, -diff);
}

function getDateRange(range) {
  const now = new Date();
  const todayStart = startOfDay(now);
  const tomorrowStart = addDays(todayStart, 1);

  switch (range) {
    case "daily":
      return { from: todayStart, to: tomorrowStart };
    case "week":
      return { from: startOfWeekMonday(now), to: tomorrowStart };
    case "month":
    case "monthly":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: tomorrowStart };
    case "year":
      return { from: new Date(now.getFullYear(), 0, 1), to: tomorrowStart };
    case "all":
    default:
      return { from: null, to: null };
  }
}

function escText(s) { return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }

// -------------------- Busy wrapper --------------------
let __busyDepth = 0;
async function runBusy(title, fn) {
  if (__busyDepth > 0) return await fn();
  __busyDepth++;
  try { return await withBusy(title, fn); }
  finally { __busyDepth--; }
}

// -------------------- Count-up animation --------------------
function animateCount(el, target, duration = 600) {
  const start = 0;
  const startTime = performance.now();
  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // ease-out cubic
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (target - start) * ease);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// -------------------- Greeting --------------------
function setGreeting(name) {
  const hour = new Date().getHours();
  let timeGreet = "Good morning";
  let emoji = "☀️";
  if (hour >= 12 && hour < 17) { timeGreet = "Good afternoon"; emoji = "🌤️"; }
  else if (hour >= 17) { timeGreet = "Good evening"; emoji = "🌙"; }

  const firstName = (name || "").split(" ")[0] || "Teacher";

  const motivations = [
    "Let's make today count! 💪",
    "You're doing great, keep going! 🔥",
    "Every entry makes a difference! ⭐",
    "Your students are counting on you! 🌟",
    "Stay awesome today! ✨",
  ];
  const randomMotivation = motivations[Math.floor(Math.random() * motivations.length)];

  if (greetingText) greetingText.textContent = `${timeGreet}, ${firstName}! ${emoji}`;
  if (greetingSub) greetingSub.textContent = randomMotivation;
}

// -------------------- Rank emoji --------------------
function rankBadge(rank) {
  if (rank === 1) return `<span class="rank-badge rank-1">🥇</span>`;
  if (rank === 2) return `<span class="rank-badge rank-2">🥈</span>`;
  if (rank === 3) return `<span class="rank-badge rank-3">🥉</span>`;
  return `<span class="rank-badge rank-n">${rank}</span>`;
}

// -------------------- Ticket Overview Counters --------------------
async function loadTicketCounters() {
  const { from, to } = getDateRange(ticketRange);

  function baseQ() {
    let q = sb.from("tickets").select("ticket_number", { count: "exact", head: true });
    if (from) q = q.gte("raised_at", from.toISOString());
    if (to) q = q.lt("raised_at", to.toISOString());
    return q;
  }

  const totalR = await baseQ();

  const newR = await (() => {
    let q = sb.from("tickets").select("ticket_number", { count: "exact", head: true });
    if (from) q = q.gte("raised_at", from.toISOString());
    if (to) q = q.lt("raised_at", to.toISOString());
    q = q.or("ticket_status.is.null,ticket_status.eq.");
    return q;
  })();

  const resolvedR = await (() => {
    let q = sb.from("tickets").select("ticket_number", { count: "exact", head: true });
    if (from) q = q.gte("raised_at", from.toISOString());
    if (to) q = q.lt("raised_at", to.toISOString());
    q = q.eq("ticket_status", "Resolved");
    return q;
  })();

  let actionQ = sb.from("touchpoints").select("ticket_number").eq("objective", "Ticket: Action");
  if (from) actionQ = actionQ.gte("touch_timestamp", from.toISOString());
  if (to) actionQ = actionQ.lt("touch_timestamp", to.toISOString());
  const { data: actionData } = await actionQ;
  const actionTickets = new Set((actionData || []).map(r => r.ticket_number).filter(Boolean));

  // Animate counters
  animateCount(cntTotal, totalR.count ?? 0);
  animateCount(cntNew, newR.count ?? 0);
  animateCount(cntResolved, resolvedR.count ?? 0);
  animateCount(cntAction, actionTickets.size);
}

// -------------------- Ticket Leaderboard --------------------
async function loadTicketLeaderboard() {
  const { from, to } = getDateRange(ticketLBRange);

  let ticketQ = sb.from("tickets").select("ticket_number,reporter_email,ticket_status");
  if (from) ticketQ = ticketQ.gte("raised_at", from.toISOString());
  if (to) ticketQ = ticketQ.lt("raised_at", to.toISOString());
  const { data: tickets } = await ticketQ;

  let actionQ = sb.from("touchpoints").select("ticket_number,owner_email").eq("objective", "Ticket: Action");
  if (from) actionQ = actionQ.gte("touch_timestamp", from.toISOString());
  if (to) actionQ = actionQ.lt("touch_timestamp", to.toISOString());
  const { data: actions } = await actionQ;

  const coordMap = new Map();

  function getCoord(email) {
    if (!email) return null;
    if (!coordMap.has(email)) coordMap.set(email, { email, actions: 0, resolved: 0, total: 0 });
    return coordMap.get(email);
  }

  for (const t of (tickets || [])) {
    const c = getCoord(t.reporter_email);
    if (c) {
      c.total++;
      if ((t.ticket_status || "").toLowerCase() === "resolved") c.resolved++;
    }
  }

  for (const a of (actions || [])) {
    const c = getCoord(a.owner_email);
    if (c) c.actions++;
  }

  const sorted = Array.from(coordMap.values()).sort((a, b) => {
    if (b.actions !== a.actions) return b.actions - a.actions;
    if (b.resolved !== a.resolved) return b.resolved - a.resolved;
    return b.total - a.total;
  });

  const headerHTML = `
    <div class="lb-header">
      <div class="lb-rank">#</div><div class="lb-name">Coordinator</div>
      <div class="lb-stat">Act.</div><div class="lb-stat">Res.</div><div class="lb-stat">Total</div>
    </div>
  `;

  if (!sorted.length) {
    ticketLBList.innerHTML = headerHTML +
      `<div class="lb-row" style="justify-content:center;color:var(--muted);padding:20px;">No data for this period 📭</div>`;
    return;
  }

  ticketLBList.innerHTML = headerHTML + sorted.map((c, i) => {
    const rank = i + 1;
    return `
      <div class="lb-row anim-slide" style="animation-delay:${i * 0.05}s;">
        <div class="lb-rank">${rankBadge(rank)}</div>
        <div class="lb-name">${escText(c.email)}</div>
        <div class="lb-stat"><b>${c.actions}</b></div>
        <div class="lb-stat">${c.resolved}</div>
        <div class="lb-stat">${c.total}</div>
      </div>
    `;
  }).join("");
}

// -------------------- Entries Leaderboard --------------------
async function loadEntriesLeaderboard() {
  const { from, to } = getDateRange(entriesLBRange);

  const all = [];
  let offset = 0;
  const chunk = 1000;
  while (true) {
    let pq = sb.from("touchpoints").select("owner_email,owner_name");
    if (from) pq = pq.gte("touch_timestamp", from.toISOString());
    if (to) pq = pq.lt("touch_timestamp", to.toISOString());
    pq = pq.range(offset, offset + chunk - 1);

    const { data, error } = await pq;
    if (error || !data?.length) break;
    all.push(...data);
    offset += data.length;
    if (data.length < chunk) break;
  }

  const countMap = new Map();
  for (const r of all) {
    const email = r.owner_email || "Unknown";
    if (!countMap.has(email)) countMap.set(email, { email, name: r.owner_name || email, count: 0 });
    countMap.get(email).count++;
  }

  const sorted = Array.from(countMap.values()).sort((a, b) => b.count - a.count);

  const headerHTML = `
    <div class="lb-header">
      <div class="lb-rank">#</div><div class="lb-name">Coordinator</div><div class="lb-stat">Entries</div>
    </div>
  `;

  if (!sorted.length) {
    entriesLBList.innerHTML = headerHTML +
      `<div class="lb-row" style="justify-content:center;color:var(--muted);padding:20px;">No entries yet 📭</div>`;
    return;
  }

  entriesLBList.innerHTML = headerHTML + sorted.map((c, i) => {
    const rank = i + 1;
    return `
      <div class="lb-row anim-slide" style="animation-delay:${i * 0.05}s;">
        <div class="lb-rank">${rankBadge(rank)}</div>
        <div class="lb-name">${escText(c.name)}<span class="lb-email">${escText(c.email)}</span></div>
        <div class="lb-stat"><b>${c.count}</b></div>
      </div>
    `;
  }).join("");
}

// -------------------- Filter pill wiring --------------------
function wireFilterPills(container, callback, stateGetter, stateSetter) {
  if (!container) return;
  container.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", async () => {
      container.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      stateSetter(btn.dataset.range);
      await runBusy("Refreshing…", callback);
    });
  });
}

// -------------------- Boot --------------------
(async () => {
  await runBusy("Loading dashboard…", async () => {
    setBusyProgress(null, "Loading navigation…");
    const { profile } = await mountNav("dashboard");

    // Set personalized greeting
    setGreeting(profile?.display_name);

    setBusyProgress(30, "Loading ticket overview…");
    await loadTicketCounters();

    setBusyProgress(55, "Loading ticket leaderboard…");
    await loadTicketLeaderboard();

    setBusyProgress(80, "Loading entries leaderboard…");
    await loadEntriesLeaderboard();

    setBusyProgress(100, "Done");
  });

  // Wire filter pills
  wireFilterPills(ticketFilterPills, loadTicketCounters, () => ticketRange, v => { ticketRange = v; });
  wireFilterPills(ticketLBFilter, loadTicketLeaderboard, () => ticketLBRange, v => { ticketLBRange = v; });
  wireFilterPills(entriesLBFilter, loadEntriesLeaderboard, () => entriesLBRange, v => { entriesLBRange = v; });
})();
