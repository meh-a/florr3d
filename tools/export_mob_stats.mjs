import { writeFileSync } from 'fs';
import { MOB_TYPES, RARITIES } from '../shared/config.js';

const rows = ['mob,rarity,hp,dmg,armor,radius,xp'];

for (const [type, def] of Object.entries(MOB_TYPES)) {
  RARITIES.forEach((r, i) => {
    const hp = def.hp * r.statMult;
    const dmg = def.dmg * r.dmgMult;
    const armor = def.armor * r.armorMult;
    const radius = def.radius * r.scale;
    const xp = def.xp * r.statMult;
    rows.push([def.name, r.name, hp, dmg, armor, radius.toFixed(2), xp].join(','));
  });
}

writeFileSync(new URL('../mob-stats.csv', import.meta.url), rows.join('\n') + '\n');
console.log('wrote mob-stats.csv');
