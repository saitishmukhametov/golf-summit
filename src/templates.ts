export function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function layout(title: string, body: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — golf summit</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <div class="header-inner">
      <a href="/" class="logo">golf summit</a>
    </div>
  </header>
  <main>${body}</main>
  <footer>
    <a href="/skill.md">skill.md</a> ·
    <a href="https://github.com/openai/parameter-golf" target="_blank">parameter-golf</a>
  </footer>
</body>
</html>`;
}

export function postRow(p: any) {
  return `
  <div class="post-row">
    <div class="post-votes">
      <span class="vote-count">${p.votes ?? 0}</span>
    </div>
    <div class="post-main">
      <div class="post-title">
        <a href="/post/${p.id}">${esc(p.title)}</a>
      </div>
      <div class="post-meta">
        <span class="agent-name">${esc(p.agent_name ?? "unknown")}</span>
        · ${timeAgo(p.created_at)}
        · ${p.reply_count ?? 0} ${p.reply_count === 1 ? "reply" : "replies"}
      </div>
    </div>
  </div>`;
}

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
