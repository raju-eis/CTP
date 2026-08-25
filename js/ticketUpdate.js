// js/ticketUpdate.js
import { sb } from "./supabaseClient.js";
import { mountNav } from "./nav.js";
import { getMe, getMyProfile } from "./auth.js";
import { enhanceSelect, refreshSelect } from "./customSelect.js";
import { withBusy, setBusyProgress } from "./busy.js";
import { attachMicButton } from "./speechToText.js";

// -------------------- DOM --------------------
const studentSelect = document.getElementById("studentSelect");
const ticketSelect = document.getElementById("ticketSelect");
const detailsSection = document.getElementById("detailsSection");
const detailsGrid = document.getElementById("detailsGrid");
const takeActionBtn = document.getElementById("takeActionBtn");
const updateParentBtn = document.getElementById("updateParentBtn");
const modalRoot = document.getElementById("modalRoot");
const actionsHistory = document.getElementById("actionsHistory");
const ticketLogs = document.getElementById("ticketLogs");
const msg = document.getElementById("msg");

// -------------------- State --------------------
let students = [];
let statusOptions = [];
let ownershipOptions = [];
let currentTicket = null;
let meEmail = "";
let meId = "";
let meDisplayName = "";

// URL params for pre-selection (from Ticket Reports redirect)
const __URL = new URL(window.location.href);
const __preStudent = __URL.searchParams.get("student") || "";
const __preTicket = __URL.searchParams.get("ticket") || "";

// -------------------- Helpers --------------------
function show(text, isError = false) {
  if (!msg) return;
  msg.style.display = "block";
  msg.style.borderColor = isError ? "rgba(239,68,68,0.55)" : "rgba(37,99,235,0.55)";
  msg.textContent = text;
}
function hideMsg() { if (msg) msg.style.display = "none"; }

function escText(s) { return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function escAttr(s) { return escText(s).replaceAll('"', "&quot;"); }

function fmtDate(isoStr) {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(isoStr) {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function daysBetween(d1, d2) {
  const ms = Math.abs(new Date(d2) - new Date(d1));
  return Math.floor(ms / 86400000);
}

function isoWeekNumber(dateObj) {
  const now = new Date(dateObj);
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

async function fetchAll(table, selectCols, orderCol) {
  const out = [];
  const chunk = 1000;
  let offset = 0;
  while (true) {
    let q = sb.from(table).select(selectCols).range(offset, offset + chunk - 1);
    if (orderCol) q = q.order(orderCol);
    const { data, error } = await q;
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    offset += data.length;
    if (data.length < chunk) break;
  }
  return out;
}

// -------------------- Derived counts (actions/parent updates) --------------------
async function fetchDerivedForTicket(ticketNumber) {
  const result = { actionCount: 0, parentCount: 0, lastActionDate: null, actions: [], parentUpdates: [] };
  if (!ticketNumber) return result;

  const objectives = ["Ticket: Action", "Ticket: Parent Update"];
  const { data, error } = await sb
    .from("touchpoints")
    .select("objective,comments_concat,touch_timestamp")
    .eq("ticket_number", ticketNumber)
    .in("objective", objectives)
    .order("touch_timestamp", { ascending: true });

  if (error || !data) return result;

  for (const r of data) {
    if (r.objective === "Ticket: Action") {
      result.actionCount++;
      result.actions.push({ text: r.comments_concat || "", date: r.touch_timestamp });
      if (r.touch_timestamp) result.lastActionDate = r.touch_timestamp;
    } else if (r.objective === "Ticket: Parent Update") {
      result.parentCount++;
      result.parentUpdates.push({ text: r.comments_concat || "", date: r.touch_timestamp });
    }
  }

  return result;
}

// -------------------- Load tickets for student --------------------
async function loadTicketsForStudent(srNumber) {
  if (!srNumber) return [];

  const stu = students.find(s => s.sr_number === srNumber);
  if (!stu) return [];

  const { data, error } = await sb
    .from("tickets")
    .select("*")
    .eq("scholar_number", srNumber)
    .order("raised_at", { ascending: false });

  if (error) {
    console.warn("Failed to load tickets:", error.message);
    return [];
  }
  return data || [];
}

// -------------------- Render ticket details --------------------
async function renderTicketDetails(ticket) {
  currentTicket = ticket;
  if (!ticket) {
    detailsSection.style.display = "none";
    return;
  }

  const derived = await fetchDerivedForTicket(ticket.ticket_number);
  const daysOpen = daysBetween(ticket.raised_at, new Date());

  detailsGrid.innerHTML = `
    <div class="detail-item">
      <div class="detail-label">Ticket Number</div>
      <div class="detail-value">${escText(ticket.ticket_number)}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Student Name</div>
      <div class="detail-value">${escText(ticket.student_child_name || ticket.student_name)}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Category</div>
      <div class="detail-value">${escText(ticket.category || "—")}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Department</div>
      <div class="detail-value">${escText(ticket.department || "—")}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Date Opened</div>
      <div class="detail-value">${fmtDate(ticket.raised_at)}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Status</div>
      <div class="detail-value" id="detailStatus">${escText(ticket.ticket_status || "—")}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Total Actions</div>
      <div class="detail-value">${derived.actionCount}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Days Opened</div>
      <div class="detail-value">${daysOpen} day${daysOpen !== 1 ? "s" : ""}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Last Action</div>
      <div class="detail-value">${fmtDateTime(derived.lastActionDate)}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Ownership</div>
      <div class="detail-value">${escText(ticket.change_ownership || "—")}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Description</div>
      <div class="detail-value" style="white-space:pre-wrap; max-width:400px;">${escText(ticket.description || "—")}</div>
    </div>
  `;

  // ---- Actions History (show all action & parent update summaries) ----
  if (actionsHistory) {
    const allEntries = [
      ...derived.actions.map(a => ({ ...a, type: "action" })),
      ...derived.parentUpdates.map(a => ({ ...a, type: "parent" })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    if (allEntries.length > 0) {
      actionsHistory.innerHTML = `
        <h3>📝 Actions & Updates (${allEntries.length})</h3>
        ${allEntries.map(entry => `
          <div class="action-entry ${entry.type === 'parent' ? 'parent-update' : ''}">
            <div class="action-meta">
              <span class="action-type">${entry.type === 'action' ? '🎯 Action Taken' : '📞 Parent Update'}</span>
              <span class="action-date">${fmtDateTime(entry.date)}</span>
            </div>
            <div class="action-text">${escText(entry.text || '—')}</div>
          </div>
        `).join('')}
      `;
    } else {
      actionsHistory.innerHTML = '';
    }
  }

  // ---- Ticket Logs Timeline ----
  if (ticketLogs) {
    const logs = [];

    // 1. Ticket creation
    logs.push({
      date: ticket.raised_at,
      type: 'create',
      text: `Ticket created — ${escText(ticket.category || 'No Category')} (${escText(ticket.department || '—')})`,
    });

    // 2. All actions and parent updates
    for (const a of derived.actions) {
      logs.push({
        date: a.date,
        type: 'action',
        text: `Action taken: ${escText((a.text || '').substring(0, 120))}${(a.text || '').length > 120 ? '…' : ''}`,
      });
    }
    for (const p of derived.parentUpdates) {
      logs.push({
        date: p.date,
        type: 'parent',
        text: `Parent updated: ${escText((p.text || '').substring(0, 120))}${(p.text || '').length > 120 ? '…' : ''}`,
      });
    }

    // 3. Status change (if status exists, it was changed at some point)
    if (ticket.ticket_status) {
      logs.push({
        date: derived.lastActionDate || ticket.raised_at,
        type: 'status',
        text: `Status changed to "${escText(ticket.ticket_status)}"`,
      });
    }

    // Sort chronologically (oldest first)
    logs.sort((a, b) => new Date(a.date) - new Date(b.date));

    if (logs.length > 0) {
      ticketLogs.innerHTML = `
        <h3>📋 Ticket Activity Log</h3>
        <div class="log-timeline">
          ${logs.map(log => `
            <div class="log-item log-${log.type}">
              <div class="log-date">${fmtDateTime(log.date)}</div>
              <div class="log-text">${log.text}</div>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      ticketLogs.innerHTML = `<div class="no-logs">No activity yet.</div>`;
    }
  }

  detailsSection.style.display = "block";
}

// -------------------- Modal (Take Action / Update Parent) --------------------
function openModal(mode) {
  // mode = "action" | "parent"
  const title = mode === "action" ? "Take Action" : "Update Parent";
  const summaryHint = mode === "action"
    ? "Describe the action taken on this ticket…"
    : "Describe the parent communication / update…";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  overlay.innerHTML = `
    <div class="modal-card">
      <h3>${title}</h3>
      <p class="muted">Ticket: ${escText(currentTicket?.ticket_number || "")}</p>

      <div class="form">
        <div class="field">
          <label class="required">Summary</label>
          <textarea id="modalSummary" rows="5" placeholder="${escAttr(summaryHint)}"></textarea>
        </div>

        <div class="field">
          <label>Change Status</label>
          <select id="modalStatus">
            <option value="">(Keep current)</option>
            ${statusOptions.map(s => `<option value="${escAttr(s)}" ${s === currentTicket?.ticket_status ? "selected" : ""}>${escText(s)}</option>`).join("")}
          </select>
        </div>

        ${mode === "action" ? `
        <div class="field">
          <label>Change Ownership</label>
          <select id="modalOwnership">
            <option value="">(Keep current)</option>
            ${ownershipOptions.map(o => `<option value="${escAttr(o)}" ${o === currentTicket?.change_ownership ? "selected" : ""}>${escText(o)}</option>`).join("")}
          </select>
        </div>
        ` : ""}
      </div>

      <div class="modal-btns">
        <button type="button" class="btn" id="modalCancel">Cancel</button>
        <button type="button" class="btn primary" id="modalSave">Save</button>
      </div>
    </div>
  `;

  modalRoot.appendChild(overlay);

  // Attach mic to summary textarea
  const summaryTA = document.getElementById("modalSummary");
  if (summaryTA) attachMicButton(summaryTA);

  // Close on cancel or overlay click
  document.getElementById("modalCancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  // Save
  document.getElementById("modalSave").addEventListener("click", async () => {
    const summary = summaryTA.value.trim();
    if (!summary) {
      alert("Please enter a summary.");
      return;
    }

    const newStatus = document.getElementById("modalStatus")?.value || "";
    const newOwnership = mode === "action" ? (document.getElementById("modalOwnership")?.value || "") : "";

    await withBusy("Saving…", async () => {
      const now = new Date();
      const week = isoWeekNumber(now);
      const objective = mode === "action" ? "Ticket: Action" : "Ticket: Parent Update";

      // 1. Save touchpoint entry
      const touchpointPayload = {
        child_name: currentTicket.student_child_name || currentTicket.student_name || "",
        medium: "Ticket Update",
        objective,
        positives: summary,
        suggestion: "",
        ticket_number: currentTicket.ticket_number,
        owner_user_id: meId,
        owner_email: meEmail,
        owner_name: meDisplayName,
        correct_owner: meDisplayName,
        touch_timestamp: now.toISOString(),
        student_name: currentTicket.student_name || "",
        class_name: currentTicket.class_name || "",
        section: currentTicket.section || "",
        sr_number: currentTicket.scholar_number || "",
        week,
        month: now.getMonth() + 1,
        year: now.getFullYear(),
        comments_concat: summary,
        time: "1 min",
        time_min: 1,
      };

      const { error: tpErr } = await sb.from("touchpoints").insert(touchpointPayload);
      if (tpErr) throw tpErr;

      // 2. Update ticket fields if changed
      const ticketPatch = {};
      if (newStatus) ticketPatch.ticket_status = newStatus;
      if (newOwnership) ticketPatch.change_ownership = newOwnership;

      if (Object.keys(ticketPatch).length > 0) {
        const { error: tkErr } = await sb.from("tickets").update(ticketPatch).eq("ticket_number", currentTicket.ticket_number);
        if (tkErr) throw tkErr;
        // Update local state
        if (newStatus) currentTicket.ticket_status = newStatus;
        if (newOwnership) currentTicket.change_ownership = newOwnership;
      }
    });

    overlay.remove();
    show(`${title} saved ✅`);
    setTimeout(hideMsg, 1500);

    // Refresh details
    await renderTicketDetails(currentTicket);
  });
}

// -------------------- Boot --------------------
(async () => {
  await mountNav("ticket-update");
  hideMsg();

  try {
    await withBusy("Loading Ticket Update…", async () => {
      setBusyProgress(null, "Checking login…");
      const me = await getMe();
      if (!me) { show("Not logged in.", true); return; }

      meEmail = me.email;
      meId = me.id;
      const profile = await getMyProfile(me.id);
      meDisplayName = profile.display_name || me.email;

      setBusyProgress(null, "Loading students…");
      students = await fetchAll("students", "child_name,student_name,class_name,section,sr_number", "sr_number");

      // Load status options
      const { data: statuses } = await sb
        .from("ticket_statuses")
        .select("label")
        .eq("is_active", true)
        .order("sort_order")
        .order("label");
      statusOptions = (statuses || []).map(s => s.label);

      // Load ownership options (all user emails from profiles)
      const { data: profilesData } = await sb
        .from("profiles")
        .select("email")
        .order("email");
      ownershipOptions = (profilesData || []).map(p => p.email).filter(Boolean);

      // Populate student dropdown
      studentSelect.innerHTML =
        `<option value=""></option>` +
        students.map(s => `<option value="${escAttr(s.sr_number)}">${escText(s.sr_number)} — ${escText(s.child_name)}</option>`).join("");

      enhanceSelect(studentSelect, { placeholder: "Search by SR# or name...", search: true, searchThreshold: 0 });
      enhanceSelect(ticketSelect, { placeholder: "Select ticket..." });

      setBusyProgress(100, "Ready");
    });

    // Wire student change → load tickets
    studentSelect.addEventListener("change", async () => {
      const sr = studentSelect.value;
      ticketSelect.disabled = true;
      ticketSelect.innerHTML = `<option value="">Loading…</option>`;
      refreshSelect(ticketSelect);
      detailsSection.style.display = "none";

      if (!sr) {
        ticketSelect.innerHTML = `<option value=""></option>`;
        refreshSelect(ticketSelect);
        return;
      }

      const tickets = await loadTicketsForStudent(sr);

      ticketSelect.innerHTML =
        `<option value=""></option>` +
        tickets.map(t => {
          const cat = t.category || "No Category";
          const date = fmtDate(t.raised_at);
          const status = t.ticket_status || "Open";
          return `<option value="${escAttr(t.ticket_number)}">${escText(t.ticket_number)} — ${escText(cat)} (${date}) [${status}]</option>`;
        }).join("");

      ticketSelect.disabled = false;
      refreshSelect(ticketSelect);

      // Pre-select ticket if from URL
      if (__preTicket && tickets.find(t => t.ticket_number === __preTicket)) {
        ticketSelect.value = __preTicket;
        refreshSelect(ticketSelect);
        const ticket = tickets.find(t => t.ticket_number === __preTicket);
        if (ticket) await renderTicketDetails(ticket);
      }
    });

    // Wire ticket change → show details
    ticketSelect.addEventListener("change", async () => {
      const tn = ticketSelect.value;
      if (!tn) {
        detailsSection.style.display = "none";
        return;
      }

      await withBusy("Loading ticket details…", async () => {
        const { data, error } = await sb.from("tickets").select("*").eq("ticket_number", tn).maybeSingle();
        if (error || !data) {
          show(error?.message || "Ticket not found.", true);
          return;
        }
        await renderTicketDetails(data);
      });
    });

    // Wire action buttons
    takeActionBtn.addEventListener("click", () => {
      if (!currentTicket) return;
      openModal("action");
    });

    updateParentBtn.addEventListener("click", () => {
      if (!currentTicket) return;
      openModal("parent");
    });

    // Pre-select student from URL
    if (__preStudent) {
      studentSelect.value = __preStudent;
      refreshSelect(studentSelect);
      studentSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }

  } catch (e) {
    console.error(e);
    show(e?.message || String(e), true);
  }
})();
