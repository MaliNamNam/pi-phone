/** Send a notification via Pushover (https://pushover.net). */
export async function sendPushoverNotification(
  token: string,
  user: string,
  title: string,
  message: string,
  url?: string,
): Promise<{ success: boolean; error?: string }> {
  const body = new URLSearchParams();
  body.append("token", token);
  body.append("user", user);
  body.append("title", title);
  body.append("message", message);
  if (url) body.append("url", url);

  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (res.ok) {
    return { success: true };
  }

  const data = await res.json().catch(() => null);
  const errors = data?.errors?.join(", ") || `HTTP ${res.status}`;
  return { success: false, error: errors };
}
