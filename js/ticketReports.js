// js/ticketReports.js  — Rewritten with Google Sheets-style header filters
import { sb } from "./supabaseClient.js";
import { mountNav } from "./nav.js";
import { getMe } from "./auth.js";
import { enhanceSelect, refreshSelect } from "./customSelect.js";
import { withBusy, setBusyProgress } from "./busy.js";
import {
  listSessions,
  getSessionLabel,
  setSessionLabel,
  getSessionRange,
  applySessionToDateInputs,
  clampRangeToSession,
} from "./session.js";

// -------------------- DOM --------------------
const sessionFilter = document.getElementById("sessionFilter");
const fromDate = document.getElementById("fromDate");
const toDate = document.getElementById("toDate");
const q = document.getElementById("q");

const applyBtn = document.getElementById("applyBtn");
const clearBtn = document.getElementById("clearBtn");
const exportBtn = document.getElementById("exportBtn");

const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");

const rowsEl = document.getElementById("rows");
const msg = document.getElementById("msg");
const meta = document.getElementById("meta");
const pageInfo = document.getElementById("pageInfo");
const tableHead = document.getElementById("tableHead");

const PAGE_SIZE = 50;
let page = 0;
let totalCount = 0;

// ownership + status options for inline (read-only) display
let ownershipOptions = [];
let statusOptions = [];

// current user context
let __meEmail = "";
let __isAdmin = false;

// -------------------- Column filter state --------------------
// Maps column key -> Set of selected values (empty = all)
const columnFilters = new Map();
let sortCol = null;
let sortDir = "asc"; // "asc" | "desc"
let openFilterPopup = null; // currently open popup element

// -------------------- Busy wrapper --------------------
let __busyDepth = 0;
async function runBusy(title, fn) {
  if (__busyDepth > 0) return await fn();
  __busyDepth++;
  try { return await withBusy(title, fn); }
  finally { __busyDepth--; }
}

// -------------------- UI helpers --------------------
function show(text, isError = false) {
  msg.style.display = "block";
  msg.style.borderColor = isError ? "rgba(255,77,109,0.55)" : "rgba(124,92,255,0.55)";
  msg.textContent = text;
}
function hideMsg() { msg.style.display = "none"; }

function escText(s) { return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function escAttr(s) { return escText(s).replaceAll('"', "&quot;"); }
function td(v) { return (v ?? "").toString(); }

function pad(n) { return String(n).padStart(2, "0"); }
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function toStartISO(yyyy_mm_dd) {
  if (!yyyy_mm_dd) return null;
  const [y, m, d] = yyyy_mm_dd.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

function isoWeekNumber(dateObj) {
  const now = new Date(dateObj);
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// -------------------- Session UI --------------------
function initSessionUI() {
  if (!sessionFilter) return;

  const sessions = listSessions({ past: 6, future: 1 });
  sessionFilter.innerHTML = sessions.map(s => `<option value="${escAttr(s)}">${escText(s)}</option>`).join("");
  const cur = getSessionLabel();
  sessionFilter.value = cur;

  enhanceSelect(sessionFilter, { placeholder: "Select session...", search: true, searchThreshold: 0 });
  refreshSelect(sessionFilter);

  applySessionToDateInputs(fromDate, toDate, cur);

  sessionFilter.addEventListener("change", async () => {
    const val = sessionFilter.value;
    setSessionLabel(val);
    applySessionToDateInputs(fromDate, toDate, val);
    page = 0;
    await loadPage();
  });
}

// -------------------- Fetch helpers --------------------
async function fetchDistinctPaged(table, col, { where = null, order = col } = {}) {
  const set = new Set();
  const chunk = 1000;
  let offset = 0;
  while (true) {
    let query = sb.from(table).select(col).order(order).range(offset, offset + chunk - 1);
    if (where) {
      for (const w of where) {
        if (w.op === "eq") query = query.eq(w.col, w.val);
        if (w.op === "is") query = query.is(w.col, w.val);
      }
    }
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) break;
    for (const r of data) {
      const v = r?.[col];
      if (v !== null && v !== undefined && String(v).trim() !== "") set.add(String(v));
    }
    offset += data.length;
    if (data.length < chunk) break;
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// -------------------- Load filters (status + ownership for display) --------------------
async function loadFilters() {
  await runBusy("Loading filters…", async () => {
    setBusyProgress(30, "Loading ticket statuses…");

    const stR = await sb
      .from("ticket_statuses")
      .select("label")
      .eq("is_active", true)
      .order("sort_order")
      .order("label");
    statusOptions = (stR.data || []).map(x => x.label).filter(Boolean);

    setBusyProgress(60, "Loading ownership values…");
    const { data: profilesData } = await sb
      .from("profiles")
      .select("email")
      .order("email");
    ownershipOptions = (profilesData || []).map(p => p.email).filter(Boolean);

    setBusyProgress(100, "Done");
  });
}

// -------------------- Google Sheets-style Header Filters --------------------
function initHeaderFilters() {
  const ths = tableHead.querySelectorAll("th[data-col]");
  ths.forEach(th => {
    th.classList.add("filterable");
    // Add filter icon
    const icon = document.createElement("span");
    icon.className = "filter-icon";
    icon.textContent = "▼";
    th.appendChild(icon);

    th.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleColumnFilter(th);
    });
  });

  // Close popups on outside click
  document.addEventListener("click", () => {
    closeAllFilterPopups();
  });
}

function closeAllFilterPopups() {
  if (openFilterPopup) {
    openFilterPopup.remove();
    openFilterPopup = null;
  }
}

function toggleColumnFilter(th) {
  const col = th.dataset.col;

  // If already open for this column, close
  if (openFilterPopup && openFilterPopup._col === col) {
    closeAllFilterPopups();
    return;
  }
  closeAllFilterPopups();

  // Get unique values for this column from visible rows' raw data
  const uniqueValues = collectUniqueValuesForColumn(col);

  const popup = document.createElement("div");
  popup.className = "col-filter-popup";
  popup._col = col;
  popup.addEventListener("click", e => e.stopPropagation());

  const currentFilter = columnFilters.get(col) || null;

  popup.innerHTML = `
    <div class="sort-btns">
      <button data-sort="asc">Sort A → Z</button>
      <button data-sort="desc">Sort Z → A</button>
    </div>
    <div class="filter-search">
      <input type="text" placeholder="Search values…" />
    </div>
    <div class="filter-actions">
      <button data-action="all">Select All</button>
      <button data-action="none">Clear All</button>
    </div>
    <div class="filter-list"></div>
    <div class="filter-apply">
      <button data-action="reset">Reset</button>
      <button class="apply-btn" data-action="apply">Apply</button>
    </div>
  `;

  th.appendChild(popup);
  openFilterPopup = popup;

  // Local selection state
  const localSelected = new Set(currentFilter ? currentFilter : uniqueValues);

  function renderList(search = "") {
    const listEl = popup.querySelector(".filter-list");
    const s = search.toLowerCase();
    const filtered = uniqueValues.filter(v => v.toLowerCase().includes(s));

    listEl.innerHTML = filtered.map(v => `
      <label class="filter-item">
        <input type="checkbox" value="${escAttr(v)}" ${localSelected.has(v) ? "checked" : ""} />
        <span>${escText(v || "(Blank)")}</span>
      </label>
    `).join("");

    listEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.addEventListener("change", () => {
        if (cb.checked) localSelected.add(cb.value);
        else localSelected.delete(cb.value);
      });
    });
  }

  renderList();

  // Search
  popup.querySelector(".filter-search input").addEventListener("input", (e) => {
    renderList(e.target.value);
  });

  // Sort buttons
  popup.querySelectorAll(".sort-btns button").forEach(btn => {
    btn.addEventListener("click", async () => {
      sortCol = col;
      sortDir = btn.dataset.sort;
      closeAllFilterPopups();
      page = 0;
      await loadPage();
    });
  });

  // Select All / Clear All
  popup.querySelector("[data-action=all]").addEventListener("click", () => {
    uniqueValues.forEach(v => localSelected.add(v));
    renderList(popup.querySelector(".filter-search input").value);
  });

  popup.querySelector("[data-action=none]").addEventListener("click", () => {
    localSelected.clear();
    renderList(popup.querySelector(".filter-search input").value);
  });

  // Reset (remove filter for this column)
  popup.querySelector("[data-action=reset]").addEventListener("click", async () => {
    columnFilters.delete(col);
    th.classList.remove("active-filter");
    closeAllFilterPopups();
    page = 0;
    await loadPage();
  });

  // Apply
  popup.querySelector("[data-action=apply]").addEventListener("click", async () => {
    if (localSelected.size === uniqueValues.length || localSelected.size === 0) {
      columnFilters.delete(col);
      th.classList.remove("active-filter");
    } else {
      columnFilters.set(col, new Set(localSelected));
      th.classList.add("active-filter");
    }
    closeAllFilterPopups();
    page = 0;
    await loadPage();
  });
}

// Collect unique values from the database for a specific column
let __allTicketsCache = null;
function collectUniqueValuesForColumn(col) {
  const set = new Set();
  if (__allTicketsCache) {
    for (const t of __allTicketsCache) {
      const v = String(t[col] ?? "").trim();
      set.add(v);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// -------------------- Query builder --------------------
function buildServerQuery({ includeCount = false } = {}) {
  const orderCol = sortCol || "raised_at";
  const ascending = sortCol ? sortDir === "asc" : false;

  let query = sb
    .from("tickets")
    .select("*", includeCount ? { count: "exact" } : undefined)
    .order(orderCol, { ascending });

  // Session + Date range
  const sessLabel = sessionFilter?.value || getSessionLabel();
  const sess = getSessionRange(sessLabel);

  const startISO = toStartISO(fromDate.value);
  const endExclusiveISO = toStartISO(toDate.value);

  const start = startISO ? new Date(startISO) : new Date(sess.start);
  const end = endExclusiveISO ? new Date(endExclusiveISO) : new Date(sess.end);

  const clamped = clampRangeToSession(start, end, sessLabel);

  query = query.gte("raised_at", clamped.from.toISOString());
  query = query.lt("raised_at", clamped.to.toISOString());

  // Text search
  const text = q.value.trim();
  if (text) {
    const esc = text.replace(/,/g, " ");
    query = query.or(
      `ticket_number.ilike.%${esc}%,student_child_name.ilike.%${esc}%,student_name.ilike.%${esc}%,category.ilike.%${esc}%,scholar_number.ilike.%${esc}%`
    );
  }

  // Apply column filters (server-side for simple eq filters)
  for (const [col, values] of columnFilters.entries()) {
    if (values.size > 0) {
      query = query.in(col, Array.from(values));
    }
  }

  return query;
}

// -------------------- Derived fetch --------------------
async function fetchDerivedForTickets(ticketNumbers) {
  const map = new Map();
  if (!ticketNumbers?.length) return map;

  const objectives = ["Ticket: Action", "Ticket: Parent Update"];
  const now = new Date();
  const curWeek = isoWeekNumber(now);
  const curYear = now.getFullYear();

  const chunkSize = 200;
  for (let i = 0; i < ticketNumbers.length; i += chunkSize) {
    const batch = ticketNumbers.slice(i, i + chunkSize);

    const { data, error } = await sb
      .from("touchpoints")
      .select("ticket_number,objective,comments_concat,week,year,touch_timestamp")
      .in("ticket_number", batch)
      .in("objective", objectives)
      .order("touch_timestamp", { ascending: true });

    if (error) { console.warn("Derived fetch failed:", error.message); continue; }

    for (const r of (data || [])) {
      const k = r.ticket_number;
      if (!map.has(k)) map.set(k, { action: [], parent: [], actionWeek: 0, parentWeek: 0, actionText: "", parentText: "" });
      const rec = map.get(k);

      if (r.objective === "Ticket: Action") {
        if (r.comments_concat) rec.action.push(String(r.comments_concat));
        if (Number(r.week) === curWeek && Number(r.year) === curYear) rec.actionWeek++;
      } else if (r.objective === "Ticket: Parent Update") {
        if (r.comments_concat) rec.parent.push(String(r.comments_concat));
        if (Number(r.week) === curWeek && Number(r.year) === curYear) rec.parentWeek++;
      }
    }
  }

  for (const [k, v] of map.entries()) {
    v.actionText = v.action.join("\n");
    v.parentText = v.parent.join("\n");
  }

  return map;
}

// -------------------- Render helpers --------------------
function renderEditable(ticket, meEmail, derived) {
  // All 4 fields are now READ-ONLY (greyed out / disabled)
  const ticketNo = ticket.ticket_number;

  const disabledText = (val) => `
    <input class="cellEdit" type="text"
      data-ticket="${escAttr(ticketNo)}" value="${escAttr(val ?? "")}" disabled />
  `;

  const disabledDate = (val) => `
    <input class="cellEdit" type="date"
      data-ticket="${escAttr(ticketNo)}" value="${escAttr(val ?? "")}" disabled />
  `;

  const disabledSelect = (val, options, placeholder) => {
    const cur = (val ?? "").toString().trim();
    const opts = [`<option value="">${escText(placeholder)}</option>`];
    const seen = new Set();
    for (const o of (options || [])) {
      const v = String(o ?? "").trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      opts.push(`<option value="${escAttr(v)}"${v === cur ? " selected" : ""}>${escText(v)}</option>`);
    }
    if (cur && !seen.has(cur)) {
      opts.push(`<option value="${escAttr(cur)}" selected>${escText(cur)}</option>`);
    }
    return `<select class="cellSelect" disabled>${opts.join("")}</select>`;
  };

  return {
    change_ownership: disabledSelect(ticket.change_ownership, ownershipOptions, "(Unassigned)"),
    follow_up_action_count_remarks: disabledText(ticket.follow_up_action_count_remarks),
    next_follow_up_date: disabledDate(ticket.next_follow_up_date),
    ticket_status: disabledSelect(ticket.ticket_status, statusOptions, "(Blank)"),

    derivedAction: td(derived?.actionText || ""),
    derivedParent: td(derived?.parentText || ""),
    derivedActionWeek: td(derived?.actionWeek ?? 0),
    derivedParentWeek: td(derived?.parentWeek ?? 0),
  };
}

function bindRowActions() {
  // Delete buttons
  rowsEl.querySelectorAll(".delBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const ticket_number = btn.dataset.ticket;
      if (!confirm(`Delete ticket ${ticket_number}?`)) return;
      await runBusy("Deleting ticket…", async () => {
        const { error } = await sb.from("tickets").delete().eq("ticket_number", ticket_number);
        if (error) return show(error.message, true);
        await loadPage();
      });
    });
  });

  // Update Ticket buttons
  rowsEl.querySelectorAll(".updateBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const sr = btn.dataset.sr;
      const tn = btn.dataset.ticket;
      window.location.href = `ticket_update.html?student=${encodeURIComponent(sr)}&ticket=${encodeURIComponent(tn)}`;
    });
  });
}

// -------------------- Data fetch --------------------
async function fetchAllTicketsForExport() {
  const all = [];
  const chunk = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await buildServerQuery({ includeCount: false }).range(offset, offset + chunk - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    offset += data.length;
    if (data.length < chunk) break;
  }
  return all;
}

// -------------------- Main load --------------------
async function loadPage() {
  hideMsg();
  rowsEl.innerHTML = `<tr><td colspan="25">Loading...</td></tr>`;

  await runBusy("Loading tickets…", async () => {
    setBusyProgress(10, "Fetching tickets…");

    // First fetch ALL for column filter values (cached)
    if (!__allTicketsCache) {
      __allTicketsCache = await fetchAllTicketsForExport();
    }

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error, count } = await buildServerQuery({ includeCount: true }).range(from, to);
    if (error) {
      rowsEl.innerHTML = `<tr><td colspan="25">${escText(error.message)}</td></tr>`;
      return;
    }

    totalCount = count ?? 0;
    meta.textContent = `Showing ${Math.min(from + 1, totalCount)}–${Math.min(to + 1, totalCount)} of ${totalCount}`;
    pageInfo.textContent = `Page ${page + 1} / ${Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}`;

    prevBtn.disabled = page <= 0;
    nextBtn.disabled = (to + 1) >= totalCount;

    if (!data?.length) {
      rowsEl.innerHTML = `<tr><td colspan="25">No results.</td></tr>`;
      return;
    }

    setBusyProgress(55, "Loading derived weekly counts…");

    const ticketNumbers = data.map(x => x.ticket_number);
    const derivedMap = await fetchDerivedForTickets(ticketNumbers);

    setBusyProgress(85, "Rendering…");
    rowsEl.innerHTML = data.map(t => {
      const d = derivedMap.get(t.ticket_number);
      const e = renderEditable(t, __meEmail, d);

      return `
        <tr>
          <td>${escText(t.ticket_number)}</td>
          <td>${escText(t.student_child_name)}</td>
          <td>${escText(t.issue_raised_by)}</td>
          <td>${escText(t.department)}</td>
          <td>${escText(t.subject)}</td>
          <td>${escText(t.category)}</td>
          <td style="max-width:420px; white-space:pre-wrap;">${escText(t.description)}</td>
          <td>${escText(fmtDateTime(t.raised_at))}</td>
          <td>${escText(t.reporter_email)}</td>
          <td>${escText(t.reporter_mobile)}</td>

          <td>${escText(t.class_name)}</td>
          <td>${escText(t.section)}</td>
          <td>${escText(t.scholar_number)}</td>

          <td>${escText(t.point_of_contact)}</td>
          <td>${escText(t.point_of_resolution)}</td>

          <td>${e.change_ownership}</td>
          <td>${e.follow_up_action_count_remarks}</td>
          <td>${e.next_follow_up_date}</td>
          <td>${e.ticket_status}</td>

          <td style="white-space:pre-wrap; max-width:420px;">${escText(e.derivedAction)}</td>
          <td style="white-space:pre-wrap; max-width:420px;">${escText(e.derivedParent)}</td>
          <td>${escText(e.derivedActionWeek)}</td>
          <td>${escText(e.derivedParentWeek)}</td>

          <td style="white-space:nowrap;">
            <button class="btn primary updateBtn" data-ticket="${escAttr(t.ticket_number)}" data-sr="${escAttr(t.scholar_number)}" style="margin-bottom:4px;">Update</button>
            <button class="btn danger delBtn" data-ticket="${escAttr(t.ticket_number)}">Delete</button>
          </td>
        </tr>
      `;
    }).join("");

    bindRowActions();
    setBusyProgress(100, "Done");
  });
}

// -------------------- Export --------------------
async function exportAllFiltered() {
  hideMsg();
  await runBusy("Preparing export…", async () => {
    setBusyProgress(10, "Fetching all filtered tickets…");
    const allTickets = await fetchAllTicketsForExport();

    setBusyProgress(45, "Loading derived weekly counts…");
    const derived = await fetchDerivedForTickets(allTickets.map(x => x.ticket_number));

    if (!allTickets.length) {
      show("No rows to export.", true);
      return;
    }

    setBusyProgress(85, "Building XLSX…");

    const HEADER = [
      "Ticket Number", "Student Name", "Issue Raised By", "Department", "Subject",
      "Category", "Description", "Date", "Reporter", "Mobile Number",
      "Date Of Incident", "Time Of Incident", "Incident Reported By", "Location Of Incident",
      "Class", "Section", "Scholar Number", "Segment",
      "Point Of Contact", "Point Of Resolution", "Keep In Loop",
      "Change Ownership", "Follow-Up/Action Dates", "Follow-Up/Action Type",
      "Follow-Up/Action Count And Remarks", "Next Follow Up Date",
      "Psych Counseling Status", "Card Status", "Punishment Execution Remark",
      "Ticket Status", "Parent Notified On Conclusion",
      "POC Follow Up Dates", "POC Follow Up Remarks", "Resolution Date",
      "Auditor Email", "Audit Date", "Audit Score", "Audit Categories", "Audit Remarks",
      "Comments by POR",
      "Ticket Action Comments", "Ticket Parent Updates",
      "#Actions this week", "#Parent Updates this week",
    ];

    const rows = allTickets.map(t => {
      const d = derived.get(t.ticket_number) || { actionWeek: 0, parentWeek: 0, actionText: "", parentText: "" };
      return {
        "Ticket Number": td(t.ticket_number),
        "Student Name": td(t.student_child_name),
        "Issue Raised By": td(t.issue_raised_by),
        "Department": td(t.department),
        "Subject": td(t.subject),
        "Category": td(t.category),
        "Description": td(t.description),
        "Date": fmtDateTime(t.raised_at),
        "Reporter": td(t.reporter_email),
        "Mobile Number": td(t.reporter_mobile),
        "Date Of Incident": td(t.date_of_incident),
        "Time Of Incident": td(t.time_of_incident),
        "Incident Reported By": td(t.incident_reported_by),
        "Location Of Incident": td(t.location_of_incident),
        "Class": td(t.class_name),
        "Section": td(t.section),
        "Scholar Number": td(t.scholar_number),
        "Segment": td(t.segment),
        "Point Of Contact": td(t.point_of_contact),
        "Point Of Resolution": td(t.point_of_resolution),
        "Keep In Loop": td(t.keep_in_loop),
        "Change Ownership": td(t.change_ownership),
        "Follow-Up/Action Dates": td(t.follow_up_action_dates),
        "Follow-Up/Action Type": td(t.follow_up_action_type),
        "Follow-Up/Action Count And Remarks": td(t.follow_up_action_count_remarks),
        "Next Follow Up Date": td(t.next_follow_up_date),
        "Psych Counseling Status": td(t.psych_counseling_status),
        "Card Status": td(t.card_status),
        "Punishment Execution Remark": td(t.punishment_execution_remark),
        "Ticket Status": td(t.ticket_status),
        "Parent Notified On Conclusion": td(t.parent_notified_on_conclusion),
        "POC Follow Up Dates": td(t.poc_follow_up_dates),
        "POC Follow Up Remarks": td(t.poc_follow_up_remarks),
        "Resolution Date": td(t.resolution_date),
        "Auditor Email": td(t.auditor_email),
        "Audit Date": td(t.audit_date),
        "Audit Score": td(t.audit_score),
        "Audit Categories": td(t.audit_categories),
        "Audit Remarks": td(t.audit_remarks),
        "Comments by POR": td(t.comments_by_por),
        "Ticket Action Comments": td(d.actionText ?? ""),
        "Ticket Parent Updates": td(d.parentText ?? ""),
        "#Actions this week": td(d.actionWeek ?? 0),
        "#Parent Updates this week": td(d.parentWeek ?? 0),
      };
    });

    const ws = window.XLSX.utils.json_to_sheet(rows, { header: HEADER });
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Tickets");

    const sessLabel = sessionFilter?.value || getSessionLabel();
    const name = `Ticket_Report_${sessLabel}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    window.XLSX.writeFile(wb, name);

    show(`Exported ${rows.length} rows ✅`);
    setBusyProgress(100, "Done");
  });
}

// -------------------- Boot --------------------
(async () => {
  const nav = await mountNav("ticket_reports");

  const me = await getMe();
  __meEmail = me?.email || "";
  __isAdmin = (nav?.profile?.role === "admin");

  initSessionUI();
  await loadFilters();

  const sess = sessionFilter?.value || getSessionLabel();
  applySessionToDateInputs(fromDate, toDate, sess);

  initHeaderFilters();
  await loadPage();
})();

// -------------------- Events --------------------
applyBtn.addEventListener("click", async () => {
  __allTicketsCache = null; // bust cache on new search
  page = 0;
  await loadPage();
});

clearBtn.addEventListener("click", async () => {
  q.value = "";
  columnFilters.clear();
  sortCol = null;
  sortDir = "asc";
  __allTicketsCache = null;

  // Remove active-filter class from all headers
  tableHead.querySelectorAll("th.active-filter").forEach(th => th.classList.remove("active-filter"));

  const sess = sessionFilter?.value || getSessionLabel();
  applySessionToDateInputs(fromDate, toDate, sess);

  page = 0;
  hideMsg();
  await loadPage();
});

prevBtn.addEventListener("click", async () => { if (page > 0) { page--; await loadPage(); } });
nextBtn.addEventListener("click", async () => { page++; await loadPage(); });

exportBtn.addEventListener("click", exportAllFiltered);
