"use strict";

const $ = id => document.getElementById(id);
// the game floors displayed damage; tiny epsilon guards float error
const fmt = n => Math.floor(n + 1e-6).toLocaleString("en-US");

const state = {
  players: null,       // player_levels.json
  weaponsIndex: null,  // weapons/index.json
  weapon: null,        // currently loaded weapon file
  weaponCache: {},
  tanks: null,
  relics: null,
  gadgetsIndex: null,   // data/gadgets/index.json
  gadgetData: {},       // id -> data/gadgets/<id>.json
  weaponBonuses: null,
  tankId: "speed",
  relicLevels: {},        // relic id -> level 1..3 (absent = not equipped)
  gadgetPartSel: {},      // "gadgetId/partId" -> variant index
  weaponBonusLevels: {},  // id -> level 1..3 (absent = not equipped)
  playerName: "Player",
};

/* ---------- persistence ---------- */

const STORAGE_KEY = "raiders-calc-v1";
const SAVED_INPUTS = ["pbase", "pextra", "wbase", "wplus", "tankbonus", "hpbonus",
                      "range", "danger", "airborne", "streak", "hpfull", "inkspent",
                      "frozen", "ferment", "tankpower", "attack"];

function snapshot() {
  const s = { inputs: {}, weapon: $("weapon").value, tankId: state.tankId,
              relicLevels: { ...state.relicLevels },
              gadgetPartSel: { ...state.gadgetPartSel },
              weaponBonusLevels: { ...state.weaponBonusLevels },
              playerName: state.playerName };
  for (const id of SAVED_INPUTS) s.inputs[id] = $(id).value;
  return s;
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); }
  catch (e) { /* storage unavailable (private mode etc.); run without memory */ }
}

function loadSavedState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null; }
  catch (e) { return null; }
}

/* ---------- presets & share links ---------- */

const PRESETS_KEY = "raiders-calc-presets-v1";

function loadPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY)) || []; }
  catch (e) { return []; }
}
function savePresets(list) {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

function showNotice(msg) {
  const n = document.createElement("div");
  n.className = "notice";
  const text = document.createElement("span");
  text.textContent = msg;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "notice-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => n.remove());
  n.append(text, close);
  const main = document.querySelector("main");
  main.insertBefore(n, main.querySelector(".tabs"));
}

function flash(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
}

async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

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

function renderTanks() {
  const wrap = $("tanks");
  wrap.innerHTML = "";
  for (const t of state.tanks.tanks) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tank" + (t.id === state.tankId ? " sel" : "");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(t.id === state.tankId));
    b.innerHTML = `<span class="icon${t.icon ? " has-img" : ""}" aria-hidden="true">` +
      `${t.icon ? `<img src="${t.icon}" alt="">` : ""}</span><span>${t.name}</span>`;
    b.addEventListener("click", () => {
      state.tankId = t.id;
      enforceRelicRules();
      pruneGadgetParts();
      renderTanks(); renderRelics(); renderGadgets(); update();
    });
    wrap.appendChild(b);
  }
  const r = currentTank().relicRules;
  const limits = Object.entries(r.limits).map(([c, n]) => `max ${n} ${c}`).join(", ");
  $("relic-rule-hint").textContent =
    `${currentTank().name}: no ${r.banned.join("/")} relics${limits ? ", " + limits : ""}.`;
}

const RELIC_CATS = [["pro", "Generic"], ["speed", "Speed"], ["power", "Power"],
                    ["tactic", "Tactical"]];


function renderRelics() {
  const wrap = $("relics");
  wrap.innerHTML = "";
  for (const [cat, catLabel] of RELIC_CATS) {
    if (currentTank().relicRules.banned.includes(cat)) continue;  // hide unusable rows
    const relics = state.relics.relics.filter(r => r.category === cat);
    if (!relics.length) continue;
    const title = document.createElement("h3");
    title.className = "gadget-title";
    title.textContent = catLabel;
    wrap.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "variant-list relic-list";
    for (const relic of relics) grid.appendChild(relicButton(relic));
    wrap.appendChild(grid);
  }
  $("relic-count").textContent =
    `${Object.keys(state.relicLevels).length}/${state.relics.maxEquipped}`;
}

function relicButton(relic) {
    const level = state.relicLevels[relic.id] || 0;
    const maxLevel = relic.maxLevel || 3;
    const reason = level === 0 ? relicAllowance(relic) : null;
    const pct = level > 0 ? relic.levels[level - 1] : relic.levels[2];
    let valueText = relic.effectText
      ? relic.effectText
      : level > 0 ? `+${pct}%` : `up to +${pct}%`;
    if (relic.id === "golden-pot")
      valueText = `Power surge (+${state.tankId === "power" ? 30 : 20}%)`;
    const pips = Array.from({ length: maxLevel }, (_, n) =>
      `<i${n + 1 <= level ? ' class="on"' : ""}></i>`).join("");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "variant" + (level > 0 ? " sel" : "");
    b.disabled = reason !== null;
    if (b.disabled) b.title = reason;
    else if (relic.description) b.title = relic.description;
    b.setAttribute("aria-label", `${relic.name}, level ${level} of 3`);
    b.innerHTML = `<span class="bname">${relic.power || relic.category}</span>
      <span class="bsub">${relic.name}</span>
      <span class="vpct${level > 0 && !relic.effectText ? "" : " upto-note"}">${valueText}</span>
      <span class="pips" aria-hidden="true">${pips}</span>`;
    b.addEventListener("click", () => {
      const next = (level + 1) % (maxLevel + 1);  // final click unequips
      if (next === 0) delete state.relicLevels[relic.id];
      else if (level > 0 || relicAllowance(relic) === null) state.relicLevels[relic.id] = next;
      renderRelics(); update();
    });
    return b;
}

function renderGadgets() {
  const wrap = $("gadgets");
  wrap.innerHTML = "";
  const borrow = currentTank().gadgetBorrow;
  const own = state.gadgetsIndex.filter(g => g.tank === state.tankId);
  const borrowable = state.gadgetsIndex.filter(g => g.tank === borrow);
  if (borrowable.length) {
    const note = document.createElement("p");
    note.className = "hint borrow-note";
    const catName = { speed: "Speed", power: "Power", tactic: "Tactical" }[borrow];
    note.textContent = `Borrowable (Ultra): one ${catName} gadget`;
    borrowable.borrowNote = note;
  }
  const selectedIds = new Set(Object.keys(state.gadgetPartSel).map(k => k.split("/")[0]));
  const borrowedSelected = [...selectedIds]
    .filter(id => (state.gadgetsIndex.find(x => x.id === id) || {}).tank === borrow);
  for (const g of [...own, ...borrowable]) {
    if (borrowable.borrowNote && g === borrowable[0]) wrap.appendChild(borrowable.borrowNote);
    let blockReason = null;
    if (!selectedIds.has(g.id)) {
      if (selectedIds.size >= MAX_GADGETS)
        blockReason = `Max ${MAX_GADGETS} gadgets equipped`;
      else if (g.tank === borrow && g.tank !== state.tankId && borrowedSelected.length >= 1)
        blockReason = "Only 1 gadget from another tank";
    }
    const data = state.gadgetData[g.id];
    const group = document.createElement("div");
    group.className = "gadget-group";
    const title = document.createElement("h3");
    title.className = "gadget-title";
    title.textContent = data.name;
    group.appendChild(title);
    for (const part of data.parts) {
      const key = `${g.id}/${part.id}`;
      const stored = state.gadgetPartSel[key];
      const selInfo = stored === undefined ? null : partSelDecode(stored, part);
      const pname = document.createElement("div");
      pname.className = "part-name";
      pname.textContent = part.name;
      pname.title = part.description;
      group.appendChild(pname);
      const list = document.createElement("div");
      list.className = "variant-list";
      const dupSelected = NON_STACKING_PARTS.has(part.id) &&
        Object.keys(state.gadgetPartSel).some(k =>
          k.endsWith("/" + part.id) && k !== key);
      part.variants.forEach((v, i) => {
        const sel = selInfo !== null && selInfo.idx === i;
        const upgraded = sel && selInfo.up;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "variant" + (sel ? " sel" : "") + (upgraded ? " upgraded" : "");
        row.disabled = blockReason !== null || dupSelected;
        if (dupSelected) row.title = `${part.name} does not stack; already active on another gadget`;
        else if (row.disabled) row.title = blockReason;
        else if (v.upgradedSlots != null) row.title = "Tap again when selected to upgrade";
        row.setAttribute("aria-pressed", String(sel));
        const slotsText = upgraded
          ? `${v.upgradedSlots} slot${v.upgradedSlots > 1 ? "s" : ""} upgraded`
          : `${v.slots} slot${v.slots > 1 ? "s" : ""}`;
        row.innerHTML =
          `<span class="stars r${v.stars}" aria-label="${v.stars} of 5 stars">${"★".repeat(v.stars)}</span>` +
          `<span class="vpct">+${v.pct}%</span>` +
          `<span class="vslots">${slotsText}</span>`;
        row.addEventListener("click", () => {
          // pick -> (upgrade if available) -> unselect; other rows replace
          if (!sel) state.gadgetPartSel[key] = i;
          else if (!upgraded && v.upgradedSlots != null) state.gadgetPartSel[key] = i + 8;
          else delete state.gadgetPartSel[key];
          renderGadgets(); update();
        });
        list.appendChild(row);
      });
      group.appendChild(list);
    }
    wrap.appendChild(group);
  }
  if (!wrap.children.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `${currentTank().name} gadgets have no parts that boost your weapon damage.`;
    wrap.appendChild(p);
  }
}

function renderWeaponBonuses() {
  const wrap = $("wbonuses");
  const max = state.weaponBonuses.maxEquipped;
  const equipped = Object.keys(state.weaponBonusLevels).length;
  wrap.innerHTML = "";
  for (const bonus of state.weaponBonuses.bonuses) {
    const level = state.weaponBonusLevels[bonus.id] || 0;
    const full = level === 0 && equipped >= max;
    const pct = level > 0 ? bonus.levels[level - 1] : bonus.levels[2];
    const val = bonus.id === "ice-breaker"
      ? "\u00d7" + Number((1 + pct / 100).toFixed(2))
      : "+" + pct + "%";
    const valueText = level > 0 ? val : `up to ${val}`;
    const pips = [1, 2, 3].map(n => `<i${n <= level ? ' class="on"' : ""}></i>`).join("");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "variant" + (level > 0 ? " sel" : "");
    b.disabled = full;
    if (full) b.title = `A weapon holds only ${max} bonuses`;
    else if (bonus.description) b.title = bonus.description;
    b.setAttribute("aria-label", `${bonus.name}, level ${level} of 3`);
    b.innerHTML = `<span class="bname">${bonus.name}</span>
      <span class="vpct${level > 0 ? "" : " upto-note"}">${valueText}</span>
      <span class="pips" aria-hidden="true">${pips}</span>`;
    b.addEventListener("click", () => {
      const next = (level + 1) % 4;  // 4th click resets to not equipped
      if (next === 0) delete state.weaponBonusLevels[bonus.id];
      else if (level > 0 || equipped < max) state.weaponBonusLevels[bonus.id] = next;
      renderWeaponBonuses(); update();
    });
    wrap.appendChild(b);
  }
  $("wbonus-count").textContent = `${equipped}/${max}`;
}

function renderWeaponSelect() {
  const sel = $("weapon");
  sel.innerHTML = "";
  for (const w of state.weaponsIndex) {
    const og = document.createElement("optgroup");
    og.label = w.name;
    const names = w.variants.length ? w.variants : [w.name];
    for (const v of names) {
      const o = document.createElement("option");
      o.value = w.slug; o.textContent = v;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = state.weaponsIndex[0].slug;
}

async function loadWeapon(slug) {
  if (!state.weaponCache[slug]) state.weaponCache[slug] = await getJSON(`data/weapons/${slug}.json`);
  state.weapon = state.weaponCache[slug];
  const atk = $("attack");
  atk.innerHTML = "";
  state.weapon.attacks.forEach((a, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = a.label;
    atk.appendChild(o);
  });
  $("attack-wrap").style.display = state.weapon.attacks.length > 1 ? "" : "none";
  $("attacks-card").hidden = state.weapon.attacks.length < 2;
  // short-range weapons cannot reach the Long Range damage band
  const longOpt = $("range").querySelector('option[value="long"]');
  longOpt.disabled = !state.weapon.longRange;
  longOpt.title = state.weapon.longRange ? "" : `${state.weapon.name} cannot reach the Long Range band`;
  if (!state.weapon.longRange && $("range").value === "long") $("range").value = "";
}

/* ---------- input handling ---------- */

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

// shrink the player stat figures so Damage and HP stay side by side
function fitStatBox() {
  const lines = Array.from(document.querySelectorAll(".stat-line"));
  const nums = [$("stat-damage"), $("stat-hp")];
  nums.forEach(n => { n.style.fontSize = ""; });
  for (let i = 0; i < 10 && lines.some(l => l.scrollWidth > l.clientWidth); i++) {
    for (const n of nums) {
      const cur = parseFloat(getComputedStyle(n).fontSize);
      n.style.fontSize = Math.max(12, cur * 0.92) + "px";
    }
  }
}
window.addEventListener("resize", fitStatBox);

// shrink the title only when it would overflow; default size otherwise
function fitTitle() {
  const h1 = document.querySelector("header h1");
  if (!h1) return;
  h1.style.fontSize = "";
  for (let i = 0; i < 10 && h1.scrollWidth > h1.clientWidth; i++) {
    const cur = parseFloat(getComputedStyle(h1).fontSize);
    h1.style.fontSize = Math.max(16, cur * 0.94) + "px";
  }
}
window.addEventListener("resize", fitTitle);

// shrink the total/base figures so both always share one line
function fitResultLine() {
  const line = document.querySelector(".result-line");
  if (!line) return;
  const nums = [$("result"), $("basedmg")];
  nums.forEach(n => { n.style.fontSize = ""; });
  for (let i = 0; i < 10 && line.scrollWidth > line.clientWidth; i++) {
    for (const n of nums) {
      const cur = parseFloat(getComputedStyle(n).fontSize);
      n.style.fontSize = Math.max(12, cur * 0.92) + "px";
    }
  }
}
window.addEventListener("resize", fitResultLine);

// shrink the formula's font so it always fits its card on one line
function fitBreakdown() {
  const el = $("breakdown");
  el.style.fontSize = "";
  const avail = el.parentElement.clientWidth;
  if (el.scrollWidth > avail && avail > 0) {
    const base = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = Math.max(8, Math.floor(base * avail / el.scrollWidth * 0.98)) + "px";
  }
}
window.addEventListener("resize", fitBreakdown);

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

/* ---------- build optimizer ---------- */

// Finds the highest-damage legal build for the current weapon, attack, and
// levels by brute force over tanks, weapon bonuses, relics, and gadget parts.
// Statuses are assumed best-case and consistent (Danger beats HP full when
// Risky Reward is equipped; Frozen assumed reachable via Freeze effects;
// Ferment only via the Tactical tank power).
function optimizeBuild() {
  const pbase = Math.min(50, Math.max(1, Math.round(+$("pbase").value || 1)));
  const pextra = pbase < 50 ? 0 : Math.min(9999, Math.max(0, Math.round(+$("pextra").value || 0)));
  const wbase = Math.min(50, Math.max(1, Math.round(+$("wbase").value || 1)));
  const wplus = wbase < 50 ? 0 : Math.min(50, Math.max(0, Math.round(+$("wplus").value || 0)));
  const atkIdx = Math.min(+$("attack").value || 0, state.weapon.attacks.length - 1);
  const pd = playerDamage(pbase, pextra);
  const bwd = state.weapon.baseDamage[Math.min(100, wbase + wplus) - 1];
  const tankMult = 1 + Math.min(200, Math.max(0, +$("tankbonus").value || 0)) / 100;
  const dmg = (pd + bwd) * state.weapon.attacks[atkIdx].factor * tankMult;
  const userFerment = $("ferment").value === "1";

  const subsets = arr => arr.reduce((acc, x) => acc.concat(acc.map(s => s.concat([x]))), [[]]);
  let best = null;

  for (const tank of state.tanks.tanks) {
    // relic combos legal for this tank
    const eligible = state.relics.relics.filter(r => !tank.relicRules.banned.includes(r.category));
    const relicCombos = subsets(eligible).filter(set => {
      if (set.length > state.relics.maxEquipped) return false;
      for (const [cat, limit] of Object.entries(tank.relicRules.limits))
        if (set.filter(r => r.category === cat).length > limit) return false;
      return true;
    });
    // gadget combos: max 3, at most 1 borrowed; taking a gadget takes all its parts
    const accessible = state.gadgetsIndex.filter(g => g.tank === tank.id || g.tank === tank.gadgetBorrow);
    const gadgetCombos = subsets(accessible).filter(set =>
      set.length <= MAX_GADGETS &&
      set.filter(g => g.tank !== tank.id).length <= 1);
    const bonusCombos = subsets(state.weaponBonuses.bonuses)
      .filter(set => set.length <= state.weaponBonuses.maxEquipped);

    for (const bonuses of bonusCombos) {
      for (const relicSet of relicCombos) {
        for (const gadgetSet of gadgetCombos) {
          const hasRisky = bonuses.some(b => b.id === "risky-reward") ||
                           relicSet.some(r => r.id === "ancient-salmon-run-slab");
          const hasPot = relicSet.some(r => r.id === "golden-pot");
          const hasPan = relicSet.some(r => r.id === "golden-frying-pan");
          const powers = ["0", "1"];
          const rangeOptions = state.weapon.longRange ? ["", "close", "long"] : ["", "close"];
          for (const pw of powers)
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
            // Ferment: kept if the player has it set, or granted by the
            // active Tactical power; never taken away by the optimizer
            const fermentViaPower = pw === "1" && (tank.id === "tactic" || hasPan);
            const ferment = (userFerment || fermentViaPower) ? 1.2 : 1;
            const total = dmg * (1 + add / 100) * mult * ferment;
            if (!best || total > best.total)
              best = { total, tank, bonuses, relicSet, partSel, range, hasRisky, pw };
          }
        }
      }
    }
  }
  return best;
}

async function applyOptimalBuild() {
  const best = optimizeBuild();
  if (!best) return;
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
  showNotice(`Optimal build applied: ${best.tank.name}, dealing ${fmt(best.total)}. ` +
    "Assumes best-case statuses (Frozen and 3 consecutive hits reachable); " +
    "your Ferment setting is kept as is.");
}

/* ---------- apply a saved/linked build ---------- */

const INPUT_DEFAULTS = { pbase: "50", pextra: "0", wbase: "50", wplus: "50",
                         tankbonus: "200", hpbonus: "400", range: "", danger: "0",
                         airborne: "0", streak: "0", hpfull: "1", inkspent: "0",
                         frozen: "0", ferment: "0", tankpower: "1", attack: "0" };

async function applySnapshot(saved) {
  // reset to defaults, then layer the snapshot on top (validating everything)
  state.relicLevels = {};
  state.gadgetPartSel = {};
  state.weaponBonusLevels = {};
  state.tankId = "speed";
  state.playerName = "Player";
  for (const id of SAVED_INPUTS) if (id !== "attack") $(id).value = INPUT_DEFAULTS[id];
  $("weapon").value = state.weaponsIndex[0].slug;

  if (saved) {
    if (saved.weapon && state.weaponsIndex.some(w => w.slug === saved.weapon))
      $("weapon").value = saved.weapon;
    if (saved.tankId && state.tanks.tanks.some(t => t.id === saved.tankId))
      state.tankId = saved.tankId;
    const relicIds = new Set(state.relics.relics.map(r => r.id));
    const wbonusIds = new Set(state.weaponBonuses.bonuses.map(b => b.id));
    for (const [id, lvl] of Object.entries(saved.relicLevels || {}))
      if (relicIds.has(id) && [1, 2, 3].includes(lvl)) state.relicLevels[id] = lvl;
    for (const [key, idx] of Object.entries(saved.gadgetPartSel || {})) {
      const [gid, pid] = key.split("/");
      const part = state.gadgetData[gid] && state.gadgetData[gid].parts.find(p => p.id === pid);
      if (part && Number.isInteger(idx) && idx >= 0 && idx < 16 &&
          partSelDecode(idx, part).idx < part.variants.length)
        state.gadgetPartSel[key] = idx;
    }
    for (const [id, lvl] of Object.entries(saved.weaponBonusLevels || {})) {
      if (!wbonusIds.has(id) || ![1, 2, 3].includes(lvl)) continue;
      if (Object.keys(state.weaponBonusLevels).length >= state.weaponBonuses.maxEquipped) break;
      state.weaponBonusLevels[id] = lvl;
    }
    enforceRelicRules();
    pruneGadgetParts();
    for (const id of SAVED_INPUTS)
      if (id !== "attack" && saved.inputs && saved.inputs[id] !== undefined)
        $(id).value = saved.inputs[id];
    if (typeof saved.playerName === "string" && saved.playerName.trim())
      state.playerName = saved.playerName.trim().slice(0, 20);
  }

  $("pname-btn").textContent = state.playerName;
  renderTanks();
  renderRelics();
  renderGadgets();
  renderWeaponBonuses();
  await loadWeapon($("weapon").value);
  if (saved && saved.inputs && saved.inputs.attack !== undefined &&
      +saved.inputs.attack < state.weapon.attacks.length)
    $("attack").value = saved.inputs.attack;
  update();
}

/* ---------- presets view ---------- */

function showTab(which) {
  $("view-create").hidden = which !== "create";
  $("view-presets").hidden = which !== "presets";
  $("tab-create").classList.toggle("active", which === "create");
  $("tab-presets").classList.toggle("active", which === "presets");
  if (which === "presets") renderPresets();
}

function renderPresets() {
  const list = loadPresets();
  const wrap = $("preset-list");
  wrap.innerHTML = "";
  $("preset-empty").hidden = list.length > 0;
  for (const preset of list) {
    const row = document.createElement("div");
    row.className = "preset-row";

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "preset-name";
    name.textContent = preset.name;
    const meta = document.createElement("div");
    meta.className = "preset-meta";
    const w = state.weaponsIndex.find(x => x.slug === (preset.data && preset.data.weapon));
    const inp = (preset.data && preset.data.inputs) || {};
    meta.textContent = w ? `${w.name} ${inp.wbase || "?"}+${inp.wplus || 0}` : "";
    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "preset-actions";
    const mkBtn = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "action-btn small";
      b.textContent = label;
      b.addEventListener("click", fn);
      return b;
    };
    actions.append(
      mkBtn("Open", async () => { await applySnapshot(preset.data); showTab("create"); }),
      mkBtn("Copy link", async e => {
        const url = shareURL({ ...preset.data, playerName: preset.name });
        try { await navigator.clipboard.writeText(url); flash(e.target, "Copied ✓"); }
        catch (err) { window.prompt("Copy this link:", url); }
      }),
      mkBtn("Rename", () => {
        const name = (window.prompt("Preset name:", preset.name) || "").trim().slice(0, 20);
        if (!name || name === preset.name) return;
        const list = loadPresets().filter(p => p.name !== name);
        const target = list.find(p => p.name === preset.name);
        if (target) { target.name = name; if (target.data) target.data.playerName = name; }
        savePresets(list);
        renderPresets();
      }),
      mkBtn("Delete", () => {
        savePresets(loadPresets().filter(p => p.name !== preset.name));
        renderPresets();
      }),
    );
    row.append(info, actions);
    wrap.appendChild(row);
  }
}

/* ---------- boot ---------- */

async function boot() {
  [state.players, state.weaponsIndex, state.tanks, state.relics, state.gadgetsIndex, state.weaponBonuses] =
    await Promise.all([
      getJSON("data/player_levels.json"),
      getJSON("data/weapons/index.json"),
      getJSON("data/tanks.json"),
      getJSON("data/relics.json"),
      getJSON("data/gadgets/index.json"),
      getJSON("data/weapon_bonuses.json"),
    ]);
  await Promise.all(state.gadgetsIndex.map(async g => {
    state.gadgetData[g.id] = await getJSON(`data/gadgets/${g.id}.json`);
  }));

  renderWeaponSelect();

  // a share link's build wins over the previous session's state
  const params = new URLSearchParams(location.search);
  let fromLink = null;
  if (params.get("build")) {
    fromLink = decodeCompact(params.get("build")) || decodeBuild(params.get("build"));
    if (fromLink && params.get("name")) fromLink.playerName = params.get("name");
    history.replaceState({}, "", location.pathname);
  }
  await applySnapshot(fromLink || loadSavedState());
  if (fromLink && fromLink.olderVersion)
    showNotice("This build link was made with an older version of the calculator. " +
               "Options added since then are unselected.");

  const nameBtn = $("pname-btn"), nameInput = $("pname-input");
  nameBtn.addEventListener("click", () => {
    nameInput.value = state.playerName === "Player" ? "" : state.playerName;
    nameBtn.hidden = true;
    nameInput.hidden = false;
    nameInput.focus();
  });
  const commitName = () => {
    state.playerName = nameInput.value.trim().slice(0, 20) || "Player";
    nameBtn.textContent = state.playerName;
    nameInput.hidden = true;
    nameBtn.hidden = false;
    update();
  };
  nameInput.addEventListener("blur", commitName);
  nameInput.addEventListener("keydown", e => {
    if (e.key === "Enter") nameInput.blur();
    if (e.key === "Escape") { nameInput.value = state.playerName; nameInput.blur(); }
  });

  $("reset").addEventListener("click", () => {
    if (!window.confirm("Reset the whole form to defaults?")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    window.location.reload();
  });

  $("tab-create").addEventListener("click", () => showTab("create"));
  $("tab-presets").addEventListener("click", () => showTab("presets"));

  $("save-preset").addEventListener("click", e => {
    const list = loadPresets().filter(p => p.name !== state.playerName);
    list.unshift({ name: state.playerName, data: snapshot() });
    savePresets(list);
    flash(e.target, "Saved ✓");
    renderPresets();
  });

  const copyCurrentLink = async e => {
    const url = shareURL(snapshot());
    try { await navigator.clipboard.writeText(url); flash(e.target, "Copied ✓"); }
    catch (err) { window.prompt("Copy this link:", url); }
  };
  $("copy-link").addEventListener("click", copyCurrentLink);
  $("optimize").addEventListener("click", applyOptimalBuild);
  $("copy-link-create").addEventListener("click", copyCurrentLink);
  $("danger").addEventListener("input", () => {
    if ($("danger").value === "1") $("hpfull").value = "0";
  });
  $("hpfull").addEventListener("input", () => {
    if ($("hpfull").value === "1") $("danger").value = "0";
  });
  $("weapon").addEventListener("change", async () => { await loadWeapon($("weapon").value); update(); });
  ["attack", "pbase", "pextra", "wbase", "wplus", "tankbonus", "hpbonus", "range",
   "danger", "airborne", "streak", "hpfull", "inkspent", "frozen", "ferment", "tankpower"]
    .forEach(id => $(id).addEventListener("input", update));
}

fitTitle();
boot().catch(err => {
  $("result").textContent = "Failed to load";
  $("breakdown").textContent = String(err) +
    ". Serve this folder over HTTP (e.g. `python3 -m http.server`); file:// blocks data loading.";
});
