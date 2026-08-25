// js/entry.js
import { sb } from "./supabaseClient.js";
import { mountNav } from "./nav.js";
import { getMe, getMyProfile } from "./auth.js";
import { enhanceSelect, refreshSelect } from "./customSelect.js";
import { withBusy, setBusyProgress } from "./busy.js";
import { attachMicButton } from "./speechToText.js";

const entriesEl = document.getElementById("entries");
const tpl = document.getElementById("entryTpl");
const addEntryBtn = document.getElementById("addEntryBtn");
const form = document.getElementById("tpForm");
const resetBtn = document.getElementById("resetBtn");
const msg = document.getElementById("msg");

let students = [];
let studentsBySR = new Map();
let mediums = [];
let objectives = [];

// -------------------- Call Prefill (from Call Reports) --------------------
const __URL = new URL(window.location.href);
const __FROM_CALL = __URL.searchParams.get("fromCall") === "1";

function readCallPrefill() {
  try {
    const raw = sessionStorage.getItem("callPrefill");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function clearCallPrefill() {
  try {
    sessionStorage.removeItem("callPrefill");
  } catch {}
}

function normalizeCallType(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("OUT")) return "OUTGOING";
  if (s.includes("IN")) return "INCOMING";
  return s;
}

function desiredMediumFromCallType(callType) {
  const ct = normalizeCallType(callType);
  if (ct === "INCOMING") return "Inbound Call";
  if (ct === "OUTGOING") return "Outbound Call";
  return "";
}

function findMediumLabelCaseInsensitive(label) {
  const want = String(label || "").trim().toLowerCase();
  if (!want) return "";
  const hit = (mediums || []).find((m) => String(m?.label || "").trim().toLowerCase() === want);
  return hit?.label || "";
}

let __callPrefill = __FROM_CALL ? readCallPrefill() : null;

// Apply prefill AFTER first block exists
function tryApplyPrefillToFirstBlock() {
  if (!__FROM_CALL) return false;
  if (!__callPrefill) return false;

  const block = entriesEl?.querySelector(".tp-entry");
  if (!block) return false;

  const refs = blockRefs(block);

  let summaryText = "";
  const pos = String(__callPrefill.positives ?? "").trim();
  const sug = String(__callPrefill.suggestions ?? "").trim();

  if (__callPrefill.summary) {
    summaryText = __callPrefill.summary.trim();
  } else if (pos || sug) {
    summaryText = [pos, sug].filter(Boolean).join("\n");
  }

  if (refs.summary && summaryText) refs.summary.value = summaryText;

  const desired = desiredMediumFromCallType(__callPrefill.call_type);
  const mediumLabel = findMediumLabelCaseInsensitive(desired);
  if (refs.medium && mediumLabel) {
    refs.medium.value = mediumLabel;
    refs.medium.dispatchEvent(new Event("change", { bubbles: true }));
    try { refreshSelect(refs.medium); } catch {}
  }

  if (__callPrefill.child_name && refs.child) {
    const prefillStu = students.find(s => s.child_name === __callPrefill.child_name);
    if (prefillStu) refs.child.value = prefillStu.sr_number;
    else refs.child.value = __callPrefill.child_name;
    refs.child.dispatchEvent(new Event("change", { bubbles: true }));
    try { refreshSelect(refs.child); } catch {}
  }

  if (refs.summary) refs.summary.dispatchEvent(new Event("input", { bubbles: true }));

  __callPrefill = null;
  clearCallPrefill();
  return true;
}

// -------------------- UI Msg helpers --------------------
function show(text, isError = false) {
  if (!msg) return;
  msg.style.display = "block";
  msg.style.borderColor = isError ? "rgba(239,68,68,0.55)" : "rgba(37,99,235,0.55)";
  msg.style.color = isError ? "#ef4444" : "var(--muted)";
  msg.textContent = text;
}
function hideMsg() {
  if (msg) msg.style.display = "none";
}

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtLocalTS(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function escText(s) { return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function escAttr(s) { return escText(s).replaceAll('"', "&quot;"); }

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

function isoWeekNumber(dateObj) {
  const now = new Date(dateObj);
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function getMediumTimeMin(label) {
  const m = mediums.find((x) => x.label === label);
  return Math.max(1, Number(m?.time_min ?? 1));
}

function buildOptions(list, valueKey = "label", labelKey = "label") {
  return (
    `<option value=""></option>` +
    (list || [])
      .map((x) => {
        const v = escAttr(x[valueKey]);
        const t = escText(x[labelKey]);
        return `<option value="${v}">${t}</option>`;
      })
      .join("")
  );
}

function blockRefs(block) {
  const q = (sel) => block.querySelector(sel);
  return {
    child: q('select[data-field="child"]'),
    medium: q('select[data-field="medium"]'),
    objective: q('select[data-field="objective"]'),
    summary: q('textarea[data-field="summary"]'),
    timeAuto: q('input[data-field="timeAuto"]'),
    tsAuto: q('input[data-field="tsAuto"]'),
    studentName: q('input[data-field="studentName"]'),
    className: q('input[data-field="className"]'),
    section: q('input[data-field="section"]'),
    srNumber: q('input[data-field="srNumber"]'),
    removeBtn: q(".tp-remove"),
    nEl: q(".tp-entry-n"),
  };
}

function fillStudentAuto(refs) {
  const s = studentsBySR.get(refs.child?.value);
  if (refs.studentName) refs.studentName.value = s?.student_name ?? "";
  if (refs.className) refs.className.value = s?.class_name ?? "";
  if (refs.section) refs.section.value = s?.section ?? "";
  if (refs.srNumber) refs.srNumber.value = s?.sr_number ?? "";
}

function fillTimeAuto(refs) {
  const minutes = getMediumTimeMin(refs.medium?.value);
  if (refs.timeAuto) refs.timeAuto.value = `${minutes} min`;
  return minutes;
}

function refreshNumbers() {
  const blocks = Array.from(entriesEl.querySelectorAll(".tp-entry"));
  blocks.forEach((b, i) => {
    const refs = blockRefs(b);
    refs.nEl.textContent = `#${i + 1}`;
    refs.removeBtn.style.display = blocks.length > 1 ? "inline-flex" : "none";
  });
}

function enhanceBlockSelects(refs) {
  if (refs.child) enhanceSelect(refs.child, { placeholder: "Search by SR# or name...", search: true, searchThreshold: 0 });
  if (refs.medium) enhanceSelect(refs.medium, { placeholder: "Select medium..." });
  if (refs.objective) enhanceSelect(refs.objective, { placeholder: "Select objective..." });
  try { if (refs.child) refreshSelect(refs.child); } catch {}
  try { if (refs.medium) refreshSelect(refs.medium); } catch {}
  try { if (refs.objective) refreshSelect(refs.objective); } catch {}
}

function createBlock(cloneFrom = null) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  const refs = blockRefs(node);

  if (refs.child) {
    refs.child.innerHTML =
      `<option value=""></option>` +
      students.map((s) => `<option value="${escAttr(s.sr_number)}">${escText(s.sr_number)} — ${escText(s.child_name)}</option>`).join("");
  }

  if (refs.medium) refs.medium.innerHTML = buildOptions(mediums, "label", "label");
  if (refs.objective) refs.objective.innerHTML = buildOptions(objectives, "label", "label");

  if (refs.timeAuto) refs.timeAuto.value = "1 min";
  if (refs.tsAuto) refs.tsAuto.value = "";

  refs.child?.addEventListener("change", () => {
    fillStudentAuto(refs);
    try { refreshSelect(refs.child); } catch {}
  });

  refs.medium?.addEventListener("change", () => {
    fillTimeAuto(refs);
    try { refreshSelect(refs.medium); } catch {}
  });

  refs.removeBtn?.addEventListener("click", () => {
    node.remove();
    refreshNumbers();
  });

  if (cloneFrom) {
    const src = blockRefs(cloneFrom);
    if (refs.child) refs.child.value = src.child?.value || "";
    if (refs.medium) refs.medium.value = src.medium?.value || "";
    if (refs.objective) refs.objective.value = src.objective?.value || "";
    if (refs.summary) refs.summary.value = src.summary?.value || "";
  }

  fillStudentAuto(refs);
  fillTimeAuto(refs);

  entriesEl.appendChild(node);
  enhanceBlockSelects(refs);
  refreshNumbers();

  // Attach mic button for speech-to-text on summary
  if (refs.summary) {
    attachMicButton(refs.summary);
  }

  return node;
}

// -------------------- Boot --------------------
(async () => {
  await mountNav("entry");
  hideMsg();

  try {
    await withBusy("Loading master data…", async () => {
      setBusyProgress(null, "Fetching students, mediums, objectives…");

      const [stu, med, obj] = await Promise.all([
        fetchAll("students", "child_name,student_name,class_name,section,sr_number", "sr_number"),
        sb.from("mediums").select("label,time_min,is_active,sort_order").eq("is_active", true).order("sort_order").order("label"),
        sb.from("objectives").select("label,is_active,sort_order").eq("is_active", true).order("sort_order").order("label"),
      ]);

      students = stu || [];
      studentsBySR = new Map(students.map((s) => [s.sr_number, s]));

      mediums = med.data || [];
      objectives = obj.data || [];
    });

    createBlock(null);

    if (__FROM_CALL && __callPrefill) {
      let applied = tryApplyPrefillToFirstBlock();
      if (!applied) {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 100));
          applied = tryApplyPrefillToFirstBlock();
          if (applied) break;
        }
      }
    }

    show(`Loaded ${students.length} students ✅`);
    setTimeout(hideMsg, 1200);
  } catch (e) {
    console.error(e);
    show(e?.message || String(e), true);
  }
})();

// -------------------- UI actions --------------------
addEntryBtn?.addEventListener("click", () => {
  const blocks = Array.from(entriesEl.querySelectorAll(".tp-entry"));
  const last = blocks[blocks.length - 1] || null;
  createBlock(last);
});

resetBtn?.addEventListener("click", () => {
  hideMsg();
  entriesEl.innerHTML = "";
  createBlock(null);

  if (__FROM_CALL && __callPrefill) {
    tryApplyPrefillToFirstBlock();
  }
});

// -------------------- Save --------------------
form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();

  const me = await getMe();
  if (!me) return show("Not logged in.", true);

  const profile = await getMyProfile(me.id);

  const blocks = Array.from(entriesEl.querySelectorAll(".tp-entry"));
  if (!blocks.length) return show("Add at least one entry.", true);

  const now = new Date();
  const week = isoWeekNumber(now);

  const payloads = [];

  for (let i = 0; i < blocks.length; i++) {
    const refs = blockRefs(blocks[i]);

    const sr_value = refs.child?.value || "";
    const s_lookup = studentsBySR.get(sr_value);
    const child_name = s_lookup?.child_name ?? "";
    const medium = refs.medium?.value || "";
    const objective = refs.objective?.value || "";

    if (!child_name || !medium || !objective) {
      return show(`Entry #${i + 1}: Please select Child Name, Medium, and Objective.`, true);
    }

    const s = s_lookup;
    const summaryText = refs.summary?.value?.trim() || "";

    const time_min = fillTimeAuto(refs);
    const timeText = `${time_min} min`;

    payloads.push({
      child_name,
      medium,
      objective,
      positives: summaryText,
      suggestion: "",

      owner_user_id: me.id,
      owner_email: me.email,
      correct_owner: profile.display_name,
      owner_name: profile.display_name,

      touch_timestamp: now.toISOString(),

      student_name: s?.student_name ?? "",
      class_name: s?.class_name ?? "",
      section: s?.section ?? "",
      sr_number: s?.sr_number ?? "",

      week,
      month: now.getMonth() + 1,
      year: now.getFullYear(),

      comments_concat: summaryText,
      time: timeText,
      time_min,
    });

    if (refs.tsAuto) refs.tsAuto.value = fmtLocalTS(now);
  }

  // Save
  await withBusy(`Saving ${payloads.length} entries…`, async () => {
    const { error } = await sb.from("touchpoints").insert(payloads);
    if (error) throw error;
  }).catch((err) => {
    show(err?.message || String(err), true);
    throw err;
  });

  show(`Saved ${payloads.length} entries ✅`);
  setTimeout(hideMsg, 1400);

  entriesEl.innerHTML = "";
  createBlock(null);
});
