"use strict";

// The build maximizer: exhaustive search over legal builds.

// Enumerates every legal combination of tank, weapon bonuses, relics, gadget
// parts, active power, and range band, and returns the best total-damage
// multiplier. Statuses are assumed best-case and consistent (Danger beats HP
// full when Risky Reward is equipped; Frozen and 3-hit streaks reachable;
// Ferment kept if set by the player, else only via the Tactical power).
function bestBonusFactor(tanks, allowLong) {
  const ex = state.maxExclude;
  const userFerment = $("ferment").value === "1";
  const subsets = arr => arr.reduce((acc, x) => acc.concat(acc.map(s => s.concat([x]))), [[]]);
  let best = null;

  for (const tank of tanks) {
    const eligible = state.relics.relics.filter(r =>
      !tank.relicRules.banned.includes(r.category) && !ex.has("relic:" + r.id));
    const relicCombos = subsets(eligible).filter(set => {
      if (set.length > state.relics.maxEquipped) return false;
      for (const [cat, limit] of Object.entries(tank.relicRules.limits))
        if (set.filter(r => r.category === cat).length > limit) return false;
      return true;
    });
    const accessible = state.gadgetsIndex.filter(g => g.tank === tank.id || g.tank === tank.gadgetBorrow);
    const gadgetCombos = subsets(accessible).filter(set =>
      set.length <= MAX_GADGETS &&
      set.filter(g => g.tank !== tank.id).length <= 1);
    const bonusCombos = subsets(state.weaponBonuses.bonuses.filter(b => !ex.has("bonus:" + b.id)))
      .filter(set => set.length <= state.weaponBonuses.maxEquipped);

    for (const bonuses of bonusCombos) {
      for (const relicSet of relicCombos) {
        for (const gadgetSet of gadgetCombos) {
          const hasRisky = bonuses.some(b => b.id === "risky-reward") ||
                           relicSet.some(r => r.id === "ancient-salmon-run-slab");
          const hasPot = relicSet.some(r => r.id === "golden-pot");
          const hasPan = relicSet.some(r => r.id === "golden-frying-pan");
          const rangeOptions = allowLong ? ["", "close", "long"] : ["", "close"];
          for (const pw of ex.has("power") ? ["0"] : ["0", "1"])
          for (const range of rangeOptions) {
            const conditions = {
              danger: hasRisky, hpfull: !hasRisky,
              close: range === "close", long: range === "long",
              frozen: true, streak: true, inkspent: true, airborne: true,
            };
            let add = 0;
            const groups = {};
            if (pw === "1" && (tank.id === "power" || hasPot))
              add += (tank.id === "power" && hasPot) ? 30 : 20;  // surge
            const apply = item => {
              if (item.mode === "mult") groups[item.group || item.id] = (groups[item.group || item.id] || 0) + item.pct;
              else add += item.pct;
            };
            for (const b of bonuses)
              if (!b.requires || conditions[b.requires]) apply({ ...b, pct: b.levels[2] });
            for (const r of relicSet)
              if (!r.requires || conditions[r.requires]) apply({ ...r, pct: r.levels[2] });
            const partSel = {};
            const bestUnique = {};  // non-stacking parts: only the best instance
            for (const g of gadgetSet) {
              for (const part of state.gadgetData[g.id].parts) {
                if (ex.has("part:" + part.id)) continue;
                if (part.requires && !conditions[part.requires]) continue;
                const bestIdx = part.variants.reduce((m, v, i) => v.pct > part.variants[m].pct ? i : m, 0);
                const pct = part.variants[bestIdx].pct;
                if (NON_STACKING_PARTS.has(part.id)) {
                  const cur = bestUnique[part.id];
                  if (!cur || pct > cur.pct) bestUnique[part.id] = { key: `${g.id}/${part.id}`, idx: bestIdx, pct };
                  continue;
                }
                partSel[`${g.id}/${part.id}`] = bestIdx;
                add += part.variants[bestIdx].pct;
              }
            }
            for (const u of Object.values(bestUnique)) {
              partSel[u.key] = u.idx;
              add += u.pct;
            }
            let mult = 1;
            for (const pct of Object.values(groups)) mult *= 1 + pct / 100;
            const fermentViaPower = pw === "1" && (tank.id === "tactic" || hasPan);
            const ferment = (userFerment || fermentViaPower) ? 1.2 : 1;
            const factor = (1 + add / 100) * mult * ferment;
            if (!best || factor > best.factor)
              best = { factor, tank, bonuses, relicSet, partSel, range, hasRisky, pw };
          }
        }
      }
    }
  }
  return best;
}

async function maximizeDamage() {
  const pinTank = $("pin-tank").value === "pin";
  const pinWeapon = $("pin-weapon").value === "pin";
  if (!window.confirm("Maximize damage? This overwrites your current selections."))
    return;

  const pbase = Math.min(50, Math.max(1, Math.round(+$("pbase").value || 1)));
  const pextra = pbase < 50 ? 0 : Math.min(9999, Math.max(0, Math.round(+$("pextra").value || 0)));
  const wbase = Math.min(50, Math.max(1, Math.round(+$("wbase").value || 1)));
  const wplus = wbase < 50 ? 0 : Math.min(50, Math.max(0, Math.round(+$("wplus").value || 0)));
  const pd = playerDamage(pbase, pextra);
  const bwd = state.weapon.baseDamage[Math.min(100, wbase + wplus) - 1];
  const tankMult = 1 + Math.min(200, Math.max(0, +$("tankbonus").value || 0)) / 100;

  const tanks = pinTank ? [currentTank()] : state.tanks.tanks;
  const factors = { long: bestBonusFactor(tanks, true), short: bestBonusFactor(tanks, false) };

  let candidates;
  if (pinWeapon) {
    const atkIdx = Math.min(+$("attack").value || 0, state.weapon.attacks.length - 1);
    candidates = [{ w: state.weapon, atkIdx }];
  } else {
    for (const wi of state.weaponsIndex)
      if (!state.weaponCache[wi.slug])
        state.weaponCache[wi.slug] = await getJSON(`data/weapons/${wi.slug}.json`);
    candidates = state.weaponsIndex.flatMap(wi => {
      const w = state.weaponCache[wi.slug];
      return w.attacks.map((_, atkIdx) => ({ w, atkIdx }));
    });
  }

  let best = null;
  for (const { w, atkIdx } of candidates) {
    const f = w.longRange ? factors.long : factors.short;
    const total = (pd + bwd) * w.attacks[atkIdx].factor * tankMult * f.factor;
    if (!best || total > best.total) best = { total, w, atkIdx, ...f };
  }
  if (!best) return;

  const weaponChanged = best.w.slug !== state.weapon.slug;
  if (weaponChanged) {
    $("weapon").value = best.w.slug;
    await loadWeapon(best.w.slug);
  }
  $("attack").value = String(best.atkIdx);
  state.tankId = best.tank.id;
  state.weaponBonusLevels = {};
  for (const b of best.bonuses) state.weaponBonusLevels[b.id] = 3;
  state.relicLevels = {};
  for (const r of best.relicSet) state.relicLevels[r.id] = Math.min(3, r.maxLevel || 3);
  state.gadgetPartSel = { ...best.partSel };
  $("range").value = best.range;
  $("danger").value = best.hasRisky ? "1" : "0";
  $("hpfull").value = best.hasRisky ? "0" : "1";
  $("frozen").value = best.bonuses.some(b => b.id === "ice-breaker") ? "1" : "0";
  $("streak").value = "3";
  $("inkspent").value = best.relicSet.some(r => r.id === "bronze-press") ? "1" : "0";
  $("airborne").value = Object.keys(best.partSel).some(k => k.includes("airborne")) ? "1" : "0";
  $("tankpower").value = best.pw;
  renderTanks(); renderRelics(); renderGadgets(); renderWeaponBonuses();
  update();
  const result = $("maximize-result");
  result.textContent = `Maximized: ${best.w.name}${weaponChanged ? " (weapon changed)" : ""} on ` +
    `${best.tank.name}, dealing ${fmt(best.total)}. Assumes best-case statuses.`;
  result.hidden = false;
}
