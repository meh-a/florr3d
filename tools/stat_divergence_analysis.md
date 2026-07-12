# Florr3d Stat Divergence Analysis

This document describes the divergence in statistics and rarity scaling between our local `florr3d` game configuration and the official **florr.io** wiki.

## 1. Divergence Summary

There are two primary areas where our game's values diverge from the official wiki:
1. **Base Petal Statistics**: The base damage of the `Light` petal is lower in our config.
2. **Rarity Scaling Multipliers**: Our project uses exponential/steeper scaling curves (with different health and damage multipliers), whereas the wiki uses a uniform scaling multiplier that applies to both health and damage and scales more gradually.

---

## 2. Rarity Multipliers Comparison

In [shared/config.js](file:///home/meh/fl/shared/config.js#L4-L12), we define `statMult` (scales health, heal, and xp) and `dmgMult` (scales damage, with a flat x3 per tier). 

In contrast, the official wiki uses a single uniform multiplier sequence for both health and damage:

| Rarity Tier | Wiki Multiplier (Health & Damage) | Local Code Damage Multiplier (`dmgMult`) | Local Code Health Multiplier (`statMult`) |
| :--- | :---: | :---: | :---: |
| **Common** | `1.0x` | `1.0x` | `1.0x` |
| **Unusual** | `1.5x` | `3.0x` | `3.75x` |
| **Rare** | `4.5x` | `9.0x` | `13.5x` |
| **Epic** | `9.0x` | `27.0x` | `54.0x` |
| **Legendary** | `27.0x` | `81.0x` | `324.0x` |
| **Mythic** | `48.6x` | `243.0x` | `3,159.0x` |
| **Ultra** | `145.8x` | `729.0x` | `196,830.0x` |
| **Super** | `437.4x` | *Not Defined* | *Not Defined* |
| **Unique** | `1,312.2x` | *Not Defined* | *Not Defined* |

---

## 3. Light Petal Comparison

The `Light` petal is defined in [shared/config.js](file:///home/meh/fl/shared/config.js#L46-L47):
* **Local config base stats**: `hp: 5`, `dmg: 7`
* **Wiki base stats**: `hp: 5`, `dmg: 13`

This results in the following stats across tiers:

### Damage
| Rarity Tier | Wiki Value | Local Calculated Value | Difference |
| :--- | :---: | :---: | :---: |
| **Common** | `13.0` | `7.0` | **-6.0** |
| **Unusual** | `19.5` | `21.0` | **+1.5** |
| **Rare** | `58.5` | `63.0` | **+4.5** |
| **Epic** | `117.0` | `189.0` | **+72.0** |
| **Legendary** | `351.0` | `567.0` | **+216.0** |
| **Mythic** | `631.8` | `1,701.0` | **+1,069.2** |
| **Ultra** | `1,895.4` | `5,103.0` | **+3,207.6** |

### Health
| Rarity Tier | Wiki Value | Local Calculated Value | Difference |
| :--- | :---: | :---: | :---: |
| **Common** | `5.0` | `5.0` | **0.0** |
| **Unusual** | `7.5` | `18.75` | **+11.25** |
| **Rare** | `22.5` | `67.5` | **+45.0** |
| **Epic** | `45.0` | `270.0` | **+225.0** |
| **Legendary** | `135.0` | `1,620.0` | **+1,485.0** |
| **Mythic** | `243.0` | `15,795.0` | **+15,552.0** |
| **Ultra** | `729.0` | `984,150.0` | **+983,421.0** |

---

## 4. Code References
* The base stats for all petals are defined in `PETAL_TYPES` starting at [shared/config.js:L39](file:///home/meh/fl/shared/config.js#L39).
* The rarity scaling factors are defined in `RARITIES` starting at [shared/config.js:L4](file:///home/meh/fl/shared/config.js#L4).
* The damage formula is computed in:
  * Client UI: [client/src/ui.js:L220](file:///home/meh/fl/client/src/ui.js#L220)
  * Server Petals: [server/petals.js:L92](file:///home/meh/fl/server/petals.js#L92)
