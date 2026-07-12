import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const dbPath = fileURLToPath(new URL('../accounts.db', import.meta.url));
const db = new Database(dbPath);

const rows = db.prepare('SELECT username, created_at, last_seen, save FROM accounts').all();

if (rows.length === 0) {
  console.log(JSON.stringify({
    totalAccounts: 0,
    activePlayers: { last1h: 0, last24h: 0, last7d: 0, last30d: 0 },
    levelStats: { avg: 0, max: 0, min: 0 },
    leaderboard: [],
    petals: {},
    petalRarities: {}
  }, null, 2));
  process.exit(0);
}

let levels = [];
let totalXp = 0;
let levelCounts = {};
let seenTimes = [];
let createdTimes = [];
let petalCounts = {};
let petalRarityCounts = {};
let userLeaderboard = [];

for (const row of rows) {
  let save = null;
  if (row.save) {
    try {
      save = JSON.parse(row.save);
    } catch (e) {
      // ignore
    }
  }

  const level = save?.level || 1;
  const xp = save?.xp || 0;
  levels.push(level);
  totalXp += xp;
  levelCounts[level] = (levelCounts[level] || 0) + 1;
  seenTimes.push(row.last_seen);
  createdTimes.push(row.created_at);

  userLeaderboard.push({
    username: row.username,
    level,
    xp,
    lastSeen: row.last_seen,
    createdAt: row.created_at
  });

  if (save?.inventory && Array.isArray(save.inventory)) {
    for (const [key, count] of save.inventory) {
      petalCounts[key] = (petalCounts[key] || 0) + count;
      const [type, rarity] = key.split(':');
      petalRarityCounts[rarity] = (petalRarityCounts[rarity] || 0) + count;
    }
  }
}

userLeaderboard.sort((a, b) => b.level - a.level || b.xp - a.xp);

const now = Date.now();
const oneHour = 60 * 60 * 1000;
const oneDay = 24 * oneHour;
const sevenDays = 7 * oneDay;
const thirtyDays = 30 * oneDay;

const active1h = rows.filter(r => now - r.last_seen <= oneHour).length;
const active24h = rows.filter(r => now - r.last_seen <= oneDay).length;
const active7d = rows.filter(r => now - r.last_seen <= sevenDays).length;
const active30d = rows.filter(r => now - r.last_seen <= thirtyDays).length;

console.log(JSON.stringify({
  totalAccounts: rows.length,
  activePlayers: {
    last1h: active1h,
    last24h: active24h,
    last7d: active7d,
    last30d: active30d
  },
  levelStats: {
    avg: Number((levels.reduce((a, b) => a + b, 0) / levels.length).toFixed(2)),
    max: Math.max(...levels),
    min: Math.min(...levels),
  },
  leaderboard: userLeaderboard.slice(0, 15),
  petals: petalCounts,
  petalRarities: petalRarityCounts
}, null, 2));
