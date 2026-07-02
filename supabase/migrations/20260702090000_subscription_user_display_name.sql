alter table public.subscriptions
add column if not exists user_display_name text;

update public.subscriptions s
set user_display_name = coalesce(
  nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''),
  case when nullif(u.username, '') is not null then '@' || u.username end,
  nullif(u.chat_title, ''),
  s.chat_id
)
from public.telegram_users u
where u.chat_id = s.chat_id
  and s.user_display_name is null;
