-- tickets visibility RLS (run in Supabase SQL editor)
-- Non-admin sees a ticket if their email is reporter, POC, POR, or current owner.
-- Admin sees all. Re-run after changing the rule set.

create or replace function public.ctp_my_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(trim(email)) from public.profiles where id = auth.uid();
$$;

create or replace function public.ctp_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role = 'admin' from public.profiles where id = auth.uid()),
    false
  );
$$;

alter table public.tickets enable row level security;

-- Drop prior permissive policies if you had "allow all authenticated" — rename as needed.
-- drop policy if exists "tickets_select_all" on public.tickets;

drop policy if exists tickets_select_assignee_or_admin on public.tickets;
create policy tickets_select_assignee_or_admin
  on public.tickets
  for select
  to authenticated
  using (
    public.ctp_is_admin()
    or lower(trim(coalesce(reporter_email, ''))) = public.ctp_my_email()
    or lower(trim(coalesce(change_ownership, ''))) = public.ctp_my_email()
    or lower(trim(coalesce(point_of_contact, ''))) = public.ctp_my_email()
    or lower(trim(coalesce(point_of_resolution, ''))) = public.ctp_my_email()
  );

drop policy if exists tickets_insert_authenticated on public.tickets;
create policy tickets_insert_authenticated
  on public.tickets
  for insert
  to authenticated
  with check (auth.uid() is not null);

drop policy if exists tickets_update_assignee_or_admin on public.tickets;
create policy tickets_update_assignee_or_admin
  on public.tickets
  for update
  to authenticated
  using (
    public.ctp_is_admin()
    or lower(trim(coalesce(reporter_email, ''))) = public.ctp_my_email()
    or lower(trim(coalesce(change_ownership, ''))) = public.ctp_my_email()
    or lower(trim(coalesce(point_of_contact, ''))) = public.ctp_my_email()
    or lower(trim(coalesce(point_of_resolution, ''))) = public.ctp_my_email()
  )
  with check (
    public.ctp_is_admin()
    or lower(trim(coalesce(reporter_email, ''))) = public.ctp_my_email()
    or lower(trim(coalesce(change_ownership, ''))) = public.ctp_my_email()
    or lower(trim(coalesce(point_of_contact, ''))) = public.ctp_my_email()
    or lower(trim(coalesce(point_of_resolution, ''))) = public.ctp_my_email()
  );

drop policy if exists tickets_delete_admin on public.tickets;
create policy tickets_delete_admin
  on public.tickets
  for delete
  to authenticated
  using (public.ctp_is_admin());
