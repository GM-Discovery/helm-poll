export function initApi() {
  const params = new URLSearchParams(location.search);
  const saved = localStorage.getItem("apiBase");

  window.App.apiBase =
    params.get("api") ||
    saved ||
    `${location.origin}/api`;
}

export async function apiGet(path) {
  const r = await fetch(`${window.App.apiBase}${path}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function apiPost(path, body) {
  const r = await fetch(`${window.App.apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
