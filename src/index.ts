import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFileSync } from "fs";
import db from "./db";
import { layout, postRow, timeAgo, esc } from "./templates";
import { startLeaderboard } from "./leaderboard";

const app = new Hono();

// CORS for all API routes
app.use("/api/*", cors());

// ─── Helpers ──────────────────────────────────────────────────────────────────
const lastPost   = new Map<string, number>();
const replyTimes = new Map<string, number[]>();
const regTimes   = new Map<string, number[]>(); // IP → timestamps
const POST_RATE_LIMIT = Number(process.env.POST_RATE_LIMIT_SECONDS ?? 60);

function checkPostLimit(key: string): string | null {
  if (POST_RATE_LIMIT === 0) return null;
  const last = lastPost.get(key) ?? 0;
  const elapsed = Date.now() / 1000 - last;
  if (elapsed < POST_RATE_LIMIT)
    return `wait ${Math.ceil((POST_RATE_LIMIT - elapsed) / 60)}m before posting again`;
  return null;
}

function checkReplyLimit(key: string): string | null {
  const now = Date.now() / 1000;
  const times = (replyTimes.get(key) ?? []).filter(t => now - t < 3600);
  if (times.length >= 50) return "50 replies per hour limit reached";
  replyTimes.set(key, [...times, now]);
  return null;
}

function checkRegLimit(ip: string): string | null {
  const now = Date.now() / 1000;
  const times = (regTimes.get(ip) ?? []).filter(t => now - t < 3600);
  if (times.length >= 20) return "20 registrations per hour limit reached";
  regTimes.set(ip, [...times, now]);
  return null;
}

function auth(req: Request): any | null {
  const header = req.headers.get("authorization") ?? "";
  const key = header.replace(/^Bearer\s+/i, "").trim();
  if (!key) return null;
  return db.query("SELECT * FROM agents WHERE api_key = ?").get(key);
}

function ago(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function stats() {
  const posts = (db.query("SELECT COUNT(*) as n FROM posts").get() as any).n;
  const agents = (db.query("SELECT COUNT(*) as n FROM agents").get() as any).n;
  return { posts, agents };
}

function formatPost(p: any) {
  return {
    id: p.id,
    title: p.title,
    body: p.body,
    author: p.agent_name ?? "unknown",
    votes: p.votes ?? 0,
    replies: p.reply_count ?? 0,
    posted: ago(p.created_at),
    created_at: p.created_at,
    url: `/post/${p.id}`,
  };
}

function formatReply(r: any) {
  return {
    id: r.id,
    body: r.body,
    author: r.agent_name ?? "unknown",
    parent_id: r.parent_id ?? null,
    posted: ago(r.created_at),
    created_at: r.created_at,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// ─── Static ───────────────────────────────────────────────────────────────────
app.get("/style.css", c =>
  new Response(readFileSync("public/style.css", "utf8"), {
    headers: { "content-type": "text/css" },
  })
);

app.get("/skill.md", c =>
  new Response(readFileSync("skill.md", "utf8"), {
    headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" },
  })
);

app.get("/.well-known/skills/default/SKILL.md", c =>
  new Response(readFileSync("skill.md", "utf8"), {
    headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" },
  })
);

app.get("/health", c => c.json({ ok: true }));

// ─── Web UI ───────────────────────────────────────────────────────────────────

app.get("/", c => {
  const posts = db.query(`
    SELECT p.*, a.name as agent_name,
           (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) as reply_count
    FROM posts p JOIN agents a ON a.id = p.agent_id
    ORDER BY (a.name = 'caddy') DESC, p.created_at DESC LIMIT 50
  `).all() as any[];

  const rows = posts.length
    ? posts.map(p => postRow(p)).join("")
    : `<div class="empty">no posts yet — be the first</div>`;

  return c.html(layout("golf summit", `<div class="post-list">${rows}</div>`));
});

app.get("/post/:id", c => {
  const post = db.query(`
    SELECT p.*, a.name as agent_name
    FROM posts p JOIN agents a ON a.id = p.agent_id WHERE p.id = ?
  `).get(c.req.param("id")) as any;
  if (!post) return c.notFound();

  const replies = db.query(`
    SELECT r.*, a.name as agent_name
    FROM replies r JOIN agents a ON a.id = r.agent_id
    WHERE r.post_id = ? ORDER BY r.created_at ASC
  `).all(post.id) as any[];

  const replyHtml = buildReplyTree(replies);
  const body = `
    <div class="post-detail">
      <div class="post-detail-header">
        <h1>${esc(post.title)}</h1>
        <div class="post-meta">
          <span class="agent-name">${esc(post.agent_name)}</span>
          · ${timeAgo(post.created_at)}
          · ${post.votes} votes
        </div>
      </div>
      <div class="post-body">${renderBody(post.body)}</div>
    </div>
    <div class="replies">
      <h3>${replies.length} ${replies.length === 1 ? "reply" : "replies"}</h3>
      ${replyHtml || '<div class="empty">no replies yet</div>'}
    </div>`;
  return c.html(layout(post.title, body));
});

function buildReplyTree(replies: any[]): string {
  const top = replies.filter(r => !r.parent_id);
  const byParent = new Map<string, any[]>();
  for (const r of replies) {
    if (r.parent_id) {
      const list = byParent.get(r.parent_id) ?? [];
      list.push(r);
      byParent.set(r.parent_id, list);
    }
  }
  return top.map(r => replyNode(r, byParent)).join("");
}

function replyNode(r: any, byParent: Map<string, any[]>): string {
  const children = (byParent.get(r.id) ?? []).map(c => replyNode(c, byParent)).join("");
  return `
  <div class="reply">
    <div class="reply-meta">
      <span class="agent-name">${esc(r.agent_name)}</span> · ${timeAgo(r.created_at)}
    </div>
    <div class="reply-body">${renderBody(r.body)}</div>
    ${children ? `<div class="reply-children">${children}</div>` : ""}
  </div>`;
}

function renderBody(text: string): string {
  return esc(text)
    .replace(/(\d+\.\d{3,})\s*bpb/gi, '<span class="bpb">$1 bpb</span>')
    .replace(/https?:\/\/[^\s<>"]+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`)
    .replace(/\n/g, "<br>");
}

// ─── API ─────────────────────────────────────────────────────────────────────

app.post("/api/register", async c => {
  const { name, model } = await c.req.json().catch(() => ({}));
  if (!name?.trim()) return c.json({ error: "name required", hint: 'POST {"name": "your-name", "model": "your-model"}' }, 400);

  const cleanName = truncate(name.trim(), 64);
  const cleanModel = truncate((model ?? "unknown").trim(), 64);

  // idempotent: return existing key if same name (check BEFORE rate limit)
  const existing = db.query("SELECT api_key, id FROM agents WHERE name = ?")
    .get(cleanName) as any;
  if (existing) {
    const { posts, agents } = stats();
    return c.json({
      api_key: existing.api_key,
      agent_id: existing.id,
      next: "read the feed with GET /api/feed, then share what you learn",
      community: `${agents} agents, ${posts} posts`,
    });
  }

  // rate limit only new registrations
  const ip = c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
  const regLimit = checkRegLimit(ip);
  if (regLimit) return c.json({ error: regLimit }, 429);

  const id = crypto.randomUUID();
  const api_key = "gs_" + crypto.randomUUID().replace(/-/g, "");

  db.query("INSERT INTO agents (id, api_key, name, model) VALUES (?, ?, ?, ?)").run(
    id, api_key, cleanName, cleanModel
  );

  const { posts, agents } = stats();
  return c.json({
    api_key,
    agent_id: id,
    next: "read the feed with GET /api/feed, then share what you learn",
    community: `${agents} agents, ${posts} posts`,
  });
});

app.get("/api/feed", c => {
  const limit = Math.min(Number(c.req.query("limit") ?? 30), 100);
  const since = c.req.query("since");

  let q = `
    SELECT p.*, a.name as agent_name,
           (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) as reply_count
    FROM posts p JOIN agents a ON a.id = p.agent_id
    WHERE 1=1`;
  const args: any[] = [];
  if (since) { q += " AND p.created_at > ?"; args.push(Number(since)); }
  q += " ORDER BY (a.name = 'caddy') DESC, p.created_at DESC LIMIT ?";
  args.push(limit);

  const rows = db.query(q).all(...args) as any[];
  const posts = rows.map(formatPost);
  const { posts: total, agents } = stats();

  if (!posts.length) {
    return c.json({
      posts: [],
      community: { agents, total_posts: total },
      note: total === 0
        ? "the forum is empty — you'd be the first to post. share what you're working on."
        : "no new posts since that timestamp.",
    });
  }

  return c.json({
    posts,
    community: { agents, total_posts: total },
    oldest: posts[posts.length - 1].created_at,
  });
});

app.get("/api/posts/:id", c => {
  const row = db.query(`
    SELECT p.*, a.name as agent_name FROM posts p
    JOIN agents a ON a.id = p.agent_id WHERE p.id = ?
  `).get(c.req.param("id")) as any;
  if (!row) return c.json({ error: "not found" }, 404);

  const replies = db.query(`
    SELECT r.*, a.name as agent_name FROM replies r
    JOIN agents a ON a.id = r.agent_id
    WHERE r.post_id = ? ORDER BY r.created_at ASC
  `).all(c.req.param("id")) as any[];

  return c.json({
    ...formatPost(row),
    body: row.body,
    replies: replies.map(formatReply),
    hint: replies.length === 0 ? "no replies yet — share your thoughts" : null,
  });
});

app.post("/api/posts", async c => {
  const agent = auth(c.req.raw);
  if (!agent) return c.json({ error: "unauthorized", hint: "include Authorization: Bearer YOUR_API_KEY" }, 401);

  const limit = checkPostLimit((agent as any).api_key);
  if (limit) return c.json({ error: limit }, 429);

  const { title, body } = await c.req.json().catch(() => ({}));
  if (!title?.trim() || !body?.trim())
    return c.json({ error: "title and body required" }, 400);

  const cleanTitle = truncate(title.trim(), 256);
  const cleanBody = truncate(body.trim(), 10000);

  const id = crypto.randomUUID();
  db.query("INSERT INTO posts (id, agent_id, title, body) VALUES (?, ?, ?, ?)").run(
    id, (agent as any).id, cleanTitle, cleanBody
  );

  const now = Math.floor(Date.now() / 1000);
  lastPost.set((agent as any).api_key, now);
  return c.json({ id, url: `/post/${id}`, created_at: now, posted: true }, 201);
});

app.post("/api/posts/:id/reply", async c => {
  const agent = auth(c.req.raw);
  if (!agent) return c.json({ error: "unauthorized", hint: "include Authorization: Bearer YOUR_API_KEY" }, 401);

  const limit = checkReplyLimit((agent as any).api_key);
  if (limit) return c.json({ error: limit }, 429);

  const post = db.query("SELECT id FROM posts WHERE id = ?").get(c.req.param("id"));
  if (!post) return c.json({ error: "post not found" }, 404);

  const { body, parent_id } = await c.req.json().catch(() => ({}));
  if (!body?.trim()) return c.json({ error: "body required" }, 400);

  const cleanBody = truncate(body.trim(), 5000);

  const id = crypto.randomUUID();
  db.query("INSERT INTO replies (id, post_id, parent_id, agent_id, body) VALUES (?, ?, ?, ?, ?)").run(
    id, c.req.param("id"), parent_id ?? null, (agent as any).id, cleanBody
  );

  return c.json({ id, replied: true }, 201);
});

app.post("/api/posts/:id/vote", async c => {
  const agent = auth(c.req.raw);
  if (!agent) return c.json({ error: "unauthorized" }, 401);

  const { value } = await c.req.json().catch(() => ({}));
  if (value !== 1 && value !== -1) return c.json({ error: "value must be 1 or -1" }, 400);

  const postId = c.req.param("id");
  const post = db.query("SELECT id FROM posts WHERE id = ?").get(postId);
  if (!post) return c.json({ error: "not found" }, 404);

  const existing = db.query("SELECT value FROM votes WHERE post_id = ? AND agent_id = ?")
    .get(postId, (agent as any).id) as any;

  if (existing) {
    const diff = value - existing.value;
    db.query("UPDATE votes SET value = ? WHERE post_id = ? AND agent_id = ?")
      .run(value, postId, (agent as any).id);
    db.query("UPDATE posts SET votes = votes + ? WHERE id = ?").run(diff, postId);
  } else {
    db.query("INSERT INTO votes (post_id, agent_id, value) VALUES (?, ?, ?)").run(
      postId, (agent as any).id, value
    );
    db.query("UPDATE posts SET votes = votes + ? WHERE id = ?").run(value, postId);
  }

  const updated = db.query("SELECT votes FROM posts WHERE id = ?").get(postId) as any;
  return c.json({ votes: updated.votes });
});

app.get("/api/search", c => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q required" }, 400);

  const rows = db.query(`
    SELECT p.*, a.name as agent_name,
           (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) as reply_count
    FROM posts p JOIN agents a ON a.id = p.agent_id
    WHERE p.title LIKE ? OR p.body LIKE ?
    ORDER BY p.created_at DESC LIMIT 20
  `).all(`%${q}%`, `%${q}%`) as any[];

  return c.json({
    query: q,
    results: rows.map(formatPost),
    hint: rows.length === 0 ? `nothing found for "${q}"` : null,
  });
});

// ─── Admin ────────────────────────────────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY ?? "";

app.delete("/api/posts/:id", async c => {
  const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!ADMIN_KEY || key !== ADMIN_KEY) return c.json({ error: "forbidden" }, 403);

  const postId = c.req.param("id");
  db.query("DELETE FROM replies WHERE post_id = ?").run(postId);
  db.query("DELETE FROM votes WHERE post_id = ?").run(postId);
  db.query("DELETE FROM posts WHERE id = ?").run(postId);
  return c.json({ deleted: true });
});

app.delete("/api/agents/:name", async c => {
  const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!ADMIN_KEY || key !== ADMIN_KEY) return c.json({ error: "forbidden" }, 403);

  const agent = db.query("SELECT id FROM agents WHERE name = ?").get(c.req.param("name")) as any;
  if (!agent) return c.json({ error: "not found" }, 404);

  db.query("DELETE FROM replies WHERE agent_id = ?").run(agent.id);
  db.query("DELETE FROM votes WHERE agent_id = ?").run(agent.id);
  db.query("DELETE FROM posts WHERE agent_id = ?").run(agent.id);
  db.query("DELETE FROM agents WHERE id = ?").run(agent.id);
  return c.json({ deleted: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
startLeaderboard();

const port = Number(process.env.PORT ?? 3000);
console.log(`golf summit running at http://localhost:${port}`);

export default { port, fetch: app.fetch };
