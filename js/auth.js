import { sb } from "./supabaseClient.js";

export async function requireAuth() {
  const { data } = await sb.auth.getSession();
  if (!data?.session) {
    window.location.href = "index.html";
    return null;
  }
  return data.session;
}

export async function getMe() {
  const { data } = await sb.auth.getUser();
  return data?.user ?? null;
}

export async function getMyProfile(userId) {
  const { data, error } = await sb
    .from("profiles")
    .select("display_name,email,role")
    .eq("id", userId)
    .single();

  if (error) throw error;
  return data;
}

export async function requireAdmin() {
  await requireAuth();
  const me = await getMe();
  if (!me) {
    window.location.href = "index.html";
    return null;
  }

  const profile = await getMyProfile(me.id);
  if (profile.role !== "admin") {
    window.location.href = "dashboard.html";
    return null;
  }
  return { me, profile };
}

export async function signOut() {
  await sb.auth.signOut();
  window.location.href = "index.html";
}

/** Quote a value for PostgREST filter strings (emails contain @). */
function filterQuote(value) {
  return `"${String(value ?? "").replaceAll('"', '\\"')}"`;
}

/** Comma-separated PostgREST or-clauses for tickets visible to this user. */
export function ticketsAssigneeOrFilter(email) {
  const e = String(email || "").trim();
  if (!e) return "";
  const q = filterQuote(e);
  // Reporter OR POC OR POR OR current owner — union of "mine" tickets
  return (
    `reporter_email.eq.${q},` +
    `change_ownership.eq.${q},` +
    `point_of_contact.eq.${q},` +
    `point_of_resolution.eq.${q}`
  );
}

/**
 * Limit a `tickets` query to rows this coordinator should see.
 * Visible = reporter, current owner, POC, or POR.
 * Admins must not call this — they see everything.
 *
 * Prefer this over a bare `.or()` when the query may also use `.or()` for
 * search/status — pass those extra or-clauses so they AND with assignee.
 */
export function scopeTicketsToAssignee(query, email, { andOrGroups = [] } = {}) {
  const assignee = ticketsAssigneeOrFilter(email);
  const groups = [];
  if (assignee) groups.push(`or(${assignee})`);
  for (const g of andOrGroups) {
    const s = String(g || "").trim();
    if (!s) continue;
    groups.push(s.startsWith("or(") ? s : `or(${s})`);
  }
  if (!groups.length) return query;
  if (groups.length === 1) {
    // or(a,b,c) → .or("a,b,c")
    return query.or(groups[0].slice(3, -1));
  }
  // and=(or(...),or(...)) so assignee AND search/status both apply
  return query.filter("and", `(${groups.join(",")})`);
}

/** True when this ticket is visible to the given email (reporter / POC / POR / owner). */
export function ticketAssignedTo(ticket, email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !ticket) return false;
  const fields = [
    ticket.reporter_email,
    ticket.change_ownership,
    ticket.point_of_contact,
    ticket.point_of_resolution,
  ];
  return fields.some((v) => String(v || "").trim().toLowerCase() === e);
}
