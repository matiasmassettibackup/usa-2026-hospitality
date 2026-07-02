update public.subscriptions s
set user_display_name = coalesce(
  nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''),
  case when nullif(u.username, '') is not null then '@' || u.username end,
  nullif(trim(concat_ws(' ', u.raw_user->>'firstName', u.raw_user->>'lastName')), ''),
  case when nullif(u.raw_user->>'username', '') is not null then '@' || (u.raw_user->>'username') end,
  nullif(u.chat_title, ''),
  s.chat_id
)
from public.telegram_users u
where u.chat_id = s.chat_id
  and nullif(s.user_display_name, '') is null;
