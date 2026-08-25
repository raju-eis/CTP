// js/teacherEntry.js
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

let teachers = [];
let teachersByEmpId = new Map();
let mediums = [];
let objectives = [];

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

function pad2(n) {
  return String(n).padStart(2, "0");
}
function fmtLocalTS(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}:${pad2(d.getSeconds())}`;
}

function escText(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function escAttr(s) {
  return escText(s).replaceAll('"', "&quot;");
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
    teacher: q('select[data-field="teacher"]'),
    medium: q('select[data-field="medium"]'),
    objective: q('select[data-field="objective"]'),
    summary: q('textarea[data-field="summary"]'),

    empId: q('input[data-field="empId"]'),
    designation: q('input[data-field="designation"]'),
    email: q('input[data-field="email"]'),
    timeAuto: q('input[data-field="timeAuto"]'),
    tsAuto: q('input[data-field="tsAuto"]'),

    removeBtn: q(".tp-remove"),
    nEl: q(".tp-entry-n"),
  };
}

function fillTeacherAuto(refs) {
  const t = teachersByEmpId.get(refs.teacher?.value);
  if (refs.empId) refs.empId.value = t?.emp_id ?? "";
  if (refs.designation) refs.designation.value = t?.designation ?? "";
  if (refs.email) refs.email.value = t?.email ?? "";
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
  if (refs.teacher) enhanceSelect(refs.teacher, { placeholder: "Search by Emp ID or name...", search: true, searchThreshold: 0 });
  if (refs.medium) enhanceSelect(refs.medium, { placeholder: "Select medium..." });
  if (refs.objective) enhanceSelect(refs.objective, { placeholder: "Select objective..." });

  try { if (refs.teacher) refreshSelect(refs.teacher); } catch {}
  try { if (refs.medium) refreshSelect(refs.medium); } catch {}
  try { if (refs.objective) refreshSelect(refs.objective); } catch {}
}

function createBlock(cloneFrom = null) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  const refs = blockRefs(node);

  // Populate teacher dropdown
  if (refs.teacher) {
    refs.teacher.innerHTML =
      `<option value=""></option>` +
      teachers
        .map((t) => `<option value="${escAttr(t.emp_id)}">${escText(t.emp_id)} — ${escText(t.teacher_name)}</option>`)
        .join("");
  }

  if (refs.medium) refs.medium.innerHTML = buildOptions(mediums, "label", "label");
  if (refs.objective) refs.objective.innerHTML = buildOptions(objectives, "label", "label");

  if (refs.timeAuto) refs.timeAuto.value = "1 min";
  if (refs.tsAuto) refs.tsAuto.value = "";

  // Event listeners
  refs.teacher?.addEventListener("change", () => {
    fillTeacherAuto(refs);
    try { refreshSelect(refs.teacher); } catch {}
  });

  refs.medium?.addEventListener("change", () => {
    fillTimeAuto(refs);
    try { refreshSelect(refs.medium); } catch {}
  });

  refs.removeBtn?.addEventListener("click", () => {
    node.remove();
    refreshNumbers();
  });

  // Clone values from previous block
  if (cloneFrom) {
    const src = blockRefs(cloneFrom);
    if (refs.teacher) refs.teacher.value = src.teacher?.value || "";
    if (refs.medium) refs.medium.value = src.medium?.value || "";
    if (refs.objective) refs.objective.value = src.objective?.value || "";
    if (refs.summary) refs.summary.value = src.summary?.value || "";
  }

  fillTeacherAuto(refs);
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
  await mountNav("teacher_entry");
  hideMsg();

  try {
    await withBusy("Loading master data…", async () => {
      setBusyProgress(null, "Fetching teachers, mediums, objectives…");

      const [tch, med, obj] = await Promise.all([
        fetchAll("teachers", "emp_id,teacher_name,designation,email", "teacher_name"),
        sb.from("teacher_mediums").select("label,time_min,is_active,sort_order").eq("is_active", true).order("sort_order").order("label"),
        sb.from("teacher_objectives").select("label,is_active,sort_order").eq("is_active", true).order("sort_order").order("label"),
      ]);

      teachers = tch || [];
      teachersByEmpId = new Map(teachers.map((t) => [t.emp_id, t]));

      mediums = med.data || [];
      objectives = obj.data || [];
    });

    createBlock(null);

    show(`Loaded ${teachers.length} teachers ✅`);
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

    const emp_id_value = refs.teacher?.value || "";
    const t_lookup = teachersByEmpId.get(emp_id_value);
    const teacher_name = t_lookup?.teacher_name ?? "";
    const medium = refs.medium?.value || "";
    const objective = refs.objective?.value || "";

    if (!teacher_name || !medium || !objective) {
      return show(`Entry #${i + 1}: Please select Teacher Name, Medium, and Objective.`, true);
    }

    const summaryText = refs.summary?.value?.trim() || "";
    const time_min = fillTimeAuto(refs);
    const timeText = `${time_min} min`;

    payloads.push({
      teacher_name,
      emp_id: t_lookup?.emp_id ?? "",
      designation: t_lookup?.designation ?? "",
      email: t_lookup?.email ?? "",
      medium,
      objective,
      summary: summaryText,

      owner_user_id: me.id,
      owner_email: me.email,
      owner_name: profile.display_name,

      touch_timestamp: now.toISOString(),

      week,
      month: now.getMonth() + 1,
      year: now.getFullYear(),

      time: timeText,
      time_min,
    });

    if (refs.tsAuto) refs.tsAuto.value = fmtLocalTS(now);
  }

  // Save
  await withBusy(`Saving ${payloads.length} entries…`, async () => {
    const { error } = await sb.from("teacher_touchpoints").insert(payloads);
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
