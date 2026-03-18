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

    // fetch verified submissions
    const submissions: any[] = [];
    try {
      const contents = await gh(`repos/${REPO}/contents/records/track_10min_16mb`) as any[];
      for (const entry of contents) {
        if (entry.type !== "dir") continue;
        try {
          const jsonFile = await gh(`repos/${REPO}/contents/${entry.path}/submission.json`) as any;
          const raw = atob(jsonFile.content.replace(/\n/g, ""));
          const sub = JSON.parse(raw);
          submissions.push({ name: sub.name, author: sub.author, bpb: sub.val_bpb, date: sub.date, blurb: sub.blurb });
        } catch {}
      }
    } catch {}

    // fetch open PRs with bpb scores
    const prs: any[] = [];
    try {
      const open = await gh(`repos/${REPO}/pulls?state=open&per_page=50`) as any[];
      const closed = await gh(`repos/${REPO}/pulls?state=closed&per_page=30`) as any[];
      for (const pr of [...open, ...closed]) {
        const text = `${pr.title} ${pr.body ?? ""}`;
        const m = text.match(/(\d+\.\d{3,})\s*bpb/i);
        if (m) {
          prs.push({
            number: pr.number,
            title: pr.title,
            author: pr.user?.login,
            bpb: parseFloat(m[1]),
            merged: !!pr.merged_at,
            open: !pr.closed_at,
          });
        }
      }
    } catch {}

    submissions.sort((a, b) => a.bpb - b.bpb);
    prs.sort((a, b) => a.bpb - b.bpb);

    // build the post body
    const lines: string[] = [];

    lines.push("verified records (10min / 8xH100 / 16MB):");
    if (submissions.length) {
      for (let i = 0; i < submissions.length; i++) {
        const s = submissions[i];
        lines.push(`  ${i + 1}. ${s.bpb} bpb — ${s.name} by ${s.author}`);
      }
    } else {
      lines.push("  1. 1.2244 bpb — Naive Baseline");
    }

    if (prs.length) {
      lines.push("");
      lines.push("PRs with reported scores:");
      for (const pr of prs.slice(0, 15)) {
        const tag = pr.merged ? "[merged]" : pr.open ? "[open]" : "[closed]";
        lines.push(`  ${pr.bpb} bpb — ${pr.title} (${pr.author}) ${tag}`);
        lines.push(`  https://github.com/${REPO}/pull/${pr.number}`);
      }
    }

    lines.push("");
    lines.push(`https://github.com/${REPO}`);

    const body = lines.join("\n");
    const best = submissions.length ? submissions[0].bpb : 1.2244;
    const title = `top golfers — best: ${best} bpb`;

    // upsert: find existing leaderboard post by bot, or create
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

    console.log(`leaderboard: ${submissions.length} verified, ${prs.length} PRs with scores, best ${best}`);
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
