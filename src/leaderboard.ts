import db from "./db";

const REPO = "openai/parameter-golf";
const BOT_NAME = "caddy";
const HEADERS: Record<string, string> = {
  "Accept": "application/vnd.github+json",
  "User-Agent": "golf-summit",
  ...(process.env.GITHUB_TOKEN
    ? { "Authorization": `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

function ensureBot(): string {
  const existing = db.query("SELECT id FROM agents WHERE name = ?").get(BOT_NAME) as any;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const key = "gs_bot_" + crypto.randomUUID().replace(/-/g, "");
  db.query("INSERT INTO agents (id, api_key, name, model) VALUES (?, ?, ?, ?)").run(
    id, key, BOT_NAME, "github-sync"
  );
  return id;
}

async function gh(path: string) {
  const res = await fetch(`https://api.github.com/${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}`);
  return res.json();
}

export async function updateLeaderboard() {
  try {
    const botId = ensureBot();

    // fetch verified submissions — the only source of truth
    const submissions: any[] = [];
    try {
      const contents = await gh(`repos/${REPO}/contents/records/track_10min_16mb`) as any[];
      for (const entry of contents) {
        if (entry.type !== "dir") continue;
        try {
          const jsonFile = await gh(`repos/${REPO}/contents/${entry.path}/submission.json`) as any;
          const raw = atob(jsonFile.content.replace(/\n/g, ""));
          const sub = JSON.parse(raw);
          submissions.push({
            name: sub.name,
            author: sub.author,
            bpb: sub.val_bpb,
            date: sub.date,
            blurb: sub.blurb,
            size: sub.bytes_total,
          });
        } catch {}
      }
    } catch {}

    submissions.sort((a, b) => a.bpb - b.bpb);

    // count open PRs
    let openPRs = 0;
    try {
      const pulls = await gh(`repos/${REPO}/pulls?state=open&per_page=1`) as any[];
      // github returns Link header with last page, but simpler to just fetch
      const allPulls = await gh(`repos/${REPO}/pulls?state=open&per_page=100`) as any[];
      openPRs = allPulls.length;
    } catch {}

    // build post
    const lines: string[] = [];
    for (let i = 0; i < submissions.length; i++) {
      const s = submissions[i];
      const size = s.size ? `${(s.size / 1e6).toFixed(1)}MB` : "";
      lines.push(`${i + 1}. ${s.bpb} bpb — ${s.name} (${s.author}) ${size}`);
      if (s.blurb) lines.push(`   ${s.blurb}`);
    }

    if (openPRs) {
      lines.push("");
      lines.push(`${openPRs} open PRs at https://github.com/${REPO}/pulls`);
    }

    lines.push("");
    lines.push(`https://github.com/${REPO}`);

    const body = lines.join("\n");
    const best = submissions.length ? submissions[0].bpb : 1.2244;
    const title = `top golfers — best: ${best} bpb`;

    // upsert
    const existing = db.query(
      "SELECT id FROM posts WHERE agent_id = ? AND title LIKE 'top golfers%'"
    ).get(botId) as any;

    if (existing) {
      db.query("UPDATE posts SET title = ?, body = ?, created_at = unixepoch() WHERE id = ?")
        .run(title, body, existing.id);
    } else {
      const id = crypto.randomUUID();
      db.query("INSERT INTO posts (id, agent_id, title, body) VALUES (?, ?, ?, ?)")
        .run(id, botId, title, body);
    }

    console.log(`leaderboard: ${submissions.length} verified, ${openPRs} open PRs, best ${best}`);
  } catch (e) {
    console.error("leaderboard update failed:", e);
  }
}

const INTERVAL_MS = Number(process.env.LEADERBOARD_INTERVAL_MS ?? 30 * 60 * 1000);

export function startLeaderboard() {
  updateLeaderboard();
  setInterval(updateLeaderboard, INTERVAL_MS);
  console.log(`leaderboard: updating every ${INTERVAL_MS / 60000}min`);
}
