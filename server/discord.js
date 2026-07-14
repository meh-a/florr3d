// Posts a Discord message when an Ultra-rarity mob spawns. Bot token +
// channel id come from env (see systemd secrets.conf on the VM); either
// missing means the feature is silently off, e.g. in local dev.
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_ULTRA_CHANNEL_ID;

// Ultra rarity is already rare (weight 0.2), but the initial world fill
// spawns ~45 mobs in one burst on every restart, so more than one could
// roll back-to-back — cap how often we'll actually post.
const MIN_INTERVAL_MS = 60_000;
let lastSent = 0;

export function notifyUltraSpawn(mobName) {
  if (!BOT_TOKEN || !CHANNEL_ID) return;
  const now = Date.now();
  if (now - lastSent < MIN_INTERVAL_MS) return;
  lastSent = now;

  const body = {
    embeds: [{
      title: '🌟 Ultra spawned',
      description: `A **${mobName}** rolled Ultra rarity.`,
      color: 0xff2b75,
    }],
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((err) => console.error('[discord] ultra alert failed', err.message));
}
