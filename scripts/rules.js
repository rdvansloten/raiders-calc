"use strict";

// Game rules: player tables, tank/relic/gadget constraints, selection codecs.

function playerDamage(base, extra) {
  const table = state.players.levels;
  if (base < 50) return table[base - 1].damage;
  return table[49].damage + state.players.postSoftcap.damagePerLevel * extra;
}
function playerHP(base, extra) {
  const table = state.players.levels;
  if (base < 50) return table[base - 1].hp;
  return table[49].hp + state.players.postSoftcap.hpPerLevel * extra;
}

function currentTank() {
  return state.tanks.tanks.find(t => t.id === state.tankId);
}

function relicEquipped(id) { return (state.relicLevels[id] || 0) > 0; }

function relicAllowance(relic) {
  // returns null if a NEW equip is allowed, or a reason string if not
  const rules = currentTank().relicRules;
  if (rules.banned.includes(relic.category))
    return `${currentTank().name} can’t equip ${relic.category} relics`;
  const limit = rules.limits[relic.category];
  if (limit !== undefined && !relicEquipped(relic.id)) {
    const equipped = state.relics.relics
      .filter(r => r.category === relic.category && relicEquipped(r.id)).length;
    if (equipped >= limit)
      return `${currentTank().name}: only ${limit} ${relic.category} relic${limit > 1 ? "s" : ""}`;
  }
  if (!relicEquipped(relic.id) &&
      Object.keys(state.relicLevels).length >= state.relics.maxEquipped)
    return `All ${state.relics.maxEquipped} relic slots used`;
  return null;
}

function enforceRelicRules() {
  // unequip anything the current tank no longer allows, respect the slot cap
  const rules = currentTank().relicRules;
  const byCat = {};
  let kept = 0;
  for (const r of state.relics.relics) {
    if (!relicEquipped(r.id)) continue;
    byCat[r.category] = (byCat[r.category] || 0) + 1;
    const limit = rules.limits[r.category];
    if (rules.banned.includes(r.category) ||
        (limit !== undefined && byCat[r.category] > limit) ||
        ++kept > state.relics.maxEquipped)
      delete state.relicLevels[r.id];
  }
}

const MAX_GADGETS = 3;  // Ultra tank: 3 gadgets, at most 1 from the linked tank
const NON_STACKING_PARTS = new Set(["damage-surge", "airborne-damage-up"]);  // one instance counts

// gadget part selections store variant index, with bit 3 marking "upgraded"
// (cheaper slot cost) for parts that support it; all parts have <= 8 variants
function partSelDecode(val, part) {
  if (part && part.variants.length <= 8) return { idx: val & 7, up: val >= 8 };
  return { idx: val, up: false };
}

function pruneGadgetParts() {
  // keep selections from the tank's own gadgets plus at most one borrowed
  // gadget, and never more than MAX_GADGETS distinct gadgets
  const borrow = currentTank().gadgetBorrow;
  let borrowed = null;
  const kept = new Set();
  for (const key of Object.keys(state.gadgetPartSel)) {
    const gid = key.split("/")[0];
    const g = state.gadgetsIndex.find(x => x.id === gid);
    if (!g) { delete state.gadgetPartSel[key]; continue; }
    if (g.tank !== state.tankId) {
      if (g.tank !== borrow) { delete state.gadgetPartSel[key]; continue; }
      if (borrowed && borrowed !== gid) { delete state.gadgetPartSel[key]; continue; }
    }
    if (!kept.has(gid) && kept.size >= MAX_GADGETS) { delete state.gadgetPartSel[key]; continue; }
    kept.add(gid);
    if (g.tank === borrow && g.tank !== state.tankId) borrowed = gid;
  }
  // non-stacking parts: keep only the first selected instance across gadgets
  const seenParts = new Set();
  for (const key of Object.keys(state.gadgetPartSel)) {
    const pid = key.split("/")[1];
    if (!NON_STACKING_PARTS.has(pid)) continue;
    if (seenParts.has(pid)) delete state.gadgetPartSel[key];
    else seenParts.add(pid);
  }
}

/* ---------- rendering ---------- */
