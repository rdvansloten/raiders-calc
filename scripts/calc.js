"use strict";

// Input clamping and the damage calculation pipeline.

function clampInputs() {
  let pbase = Math.min(50, Math.max(1, Math.round(+$("pbase").value || 1)));
  let pextra = Math.min(9999, Math.max(0, Math.round(+$("pextra").value || 0)));
  if (pbase < 50) pextra = 0;              // "+N" levels only exist past the level-50 softcap
  $("pextra").disabled = pbase < 50;

  let wbase = Math.min(50, Math.max(1, Math.round(+$("wbase").value || 1)));
  let wplus = Math.max(0, Math.round(+$("wplus").value || 0));
  if (wbase < 50) wplus = 0;          // "+N" upgrades only exist at base level 50
  wplus = Math.min(50, wplus);        // 50+50 = level 100 cap
  $("wplus").disabled = wbase < 50;
  if (document.activeElement !== $("pbase")) $("pbase").value = pbase;
  if (document.activeElement !== $("pextra") || +$("pextra").value > 9999) $("pextra").value = pextra;
  if (document.activeElement !== $("wbase")) $("wbase").value = wbase;
  if ((+$("wplus").value || 0) !== wplus) $("wplus").value = wplus;
  return { pbase, pextra, wbase, wplus };
}

function update() {
  if (!state.weapon) return;
  const { pbase, pextra, wbase, wplus } = clampInputs();
  const eff = Math.min(100, wbase + wplus);
  const atkIdx = Math.min(+$("attack").value || 0, state.weapon.attacks.length - 1);
  const atk = state.weapon.attacks[atkIdx];
  const tankMult = 1 + Math.min(200, Math.max(0, +$("tankbonus").value || 0)) / 100;

  const pd = playerDamage(pbase, pextra);
  const baseHP = playerHP(pbase, pextra);
  const hpMult = 1 + Math.min(400, Math.max(0, +$("hpbonus").value || 0)) / 100;
  const dispHP = Math.floor(baseHP * hpMult);  // the game floors displayed HP
  $("conc-note-bonus").hidden = !(state.weaponBonusLevels["concentrated-attack"] > 0);
  $("conc-note-relic").hidden = !(state.relicLevels["regal-scepter"] > 0);
  $("stat-damage").textContent = fmt(pd);
  $("stat-hp").textContent = fmt(dispHP);
  $("stat-hp-base").textContent =
    `base ${baseHP % 1 ? baseHP.toFixed(1) : fmt(baseHP)} × ${hpMult.toFixed(1)} bonus`;

  const bwd = state.weapon.baseDamage[eff - 1];
  const dmg = (pd + bwd) * atk.factor * tankMult;

  // how much the "+N" player levels contribute to dealt damage with this weapon
  const softcapDmg = state.players.levels[49].damage;
  if (pbase === 50 && pextra > 0) {
    const gain = pd - softcapDmg;
    $("stat-dmg-note").textContent =
      `+${fmt(gain)} from +${fmt(pextra)} levels (+${(100 * gain / (softcapDmg + bwd)).toFixed(2)}% dealt)`;
  } else {
    $("stat-dmg-note").textContent = "base character damage";
  }

  // In Danger and HP full are mutually exclusive: turning one on clears
  // and greys out the other
  if ($("danger").value === "1" && $("hpfull").value === "1") $("hpfull").value = "0";
  $("hpfull").disabled = $("danger").value === "1";
  $("danger").disabled = $("hpfull").value === "1";
  const conditions = {
    frozen: $("frozen").value === "1",
    close: $("range").value === "close",
    long: $("range").value === "long",
    danger: $("danger").value === "1",
    airborne: $("airborne").value === "1",
    streak: $("streak").value === "3",
    hpfull: $("hpfull").value === "1",
    inkspent: $("inkspent").value === "1",
  };
  // one on/off switch: the tank and equipped Pro relics decide the effects.
  // Native power (upgraded by its own Pro relic) plus any granted base powers.
  const powerOn = $("tankpower").value === "1";
  const surgeActive = powerOn && (state.tankId === "power" || relicEquipped("golden-pot"));
  const surgePct = state.tankId === "power" && relicEquipped("golden-pot") ? 30 : 20;
  const fermentViaPower = powerOn &&
    (state.tankId === "tactic" || relicEquipped("golden-frying-pan"));
  if (fermentViaPower) {
    $("ferment").value = "1";       // the Tactical power guarantees Ferment
    $("ferment").disabled = true;
  } else {
    $("ferment").disabled = false;
  }
  // additive pool sums once; multiplier groups sum WITHIN the group
  // (weapon bonus + matching relic), then each group multiplies the total
  let add = 0;
  if (surgeActive) add += surgePct;
  const groups = {};
  const applyBonus = b => {
    if (b.mode === "mult") groups[b.group || b.id] = (groups[b.group || b.id] || 0) + b.pct;
    else add += b.pct;
  };
  for (const r of state.relics.relics) {
    const level = state.relicLevels[r.id] || 0;
    if (level === 0) continue;
    if (r.requires && !conditions[r.requires]) continue;
    applyBonus({ ...r, pct: r.levels[level - 1] });
  }
  for (const w of state.weaponBonuses.bonuses) {
    const level = state.weaponBonusLevels[w.id] || 0;
    if (level === 0) continue;
    if (w.requires && !conditions[w.requires]) continue;
    applyBonus({ ...w, pct: w.levels[level - 1] });
  }
  for (const [key, idx] of Object.entries(state.gadgetPartSel)) {
    const [gid, pid] = key.split("/");
    const g = state.gadgetsIndex.find(x => x.id === gid);
    if (!g || (g.tank !== state.tankId && g.tank !== currentTank().gadgetBorrow)) continue;
    const part = state.gadgetData[gid].parts.find(p => p.id === pid);
    if (!part) continue;
    if (part.requires && !conditions[part.requires]) continue;
    const info = partSelDecode(idx, part);
    add += part.variants[Math.min(info.idx, part.variants.length - 1)].pct;
  }
  let multFactor = 1;
  for (const pct of Object.values(groups)) multFactor *= 1 + pct / 100;
  const ferment = $("ferment").value === "1" ? 1.2 : 1;  // stacks with Ice Breaker
  const bonusFactor = (1 + add / 100) * multFactor * ferment;

  $("result").textContent = fmt(dmg * bonusFactor);
  $("basedmg").textContent = fmt(dmg);
  $("breakdown").textContent =
    `(${fmt(pd)} + ${fmt(bwd)}) × ${atk.factor} × ${tankMult.toFixed(1)} = ${fmt(dmg)}` +
    (bonusFactor !== 1 ? `, × ${bonusFactor.toFixed(3)} bonuses = ${fmt(dmg * bonusFactor)}` : "");
  fitBreakdown();
  fitResultLine();
  fitStatBox();

  const tbody = $("attack-table");
  tbody.innerHTML = "";
  state.weapon.attacks.forEach((a, i) => {
    const tr = document.createElement("tr");
    if (i === atkIdx) tr.className = "sel";
    tr.innerHTML = `<td>${a.label}</td><td class="num">${a.factor}</td>` +
      `<td class="num">${fmt((pd + bwd) * a.factor * tankMult * bonusFactor)}</td>`;
    tbody.appendChild(tr);
  });

  saveState();
}

/* ---------- damage maximizer ---------- */
