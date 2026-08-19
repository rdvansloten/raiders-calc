"use strict";

// All DOM rendering: cards, tiles, fitters, notices, anchors, presets view.

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
  const wrap = $("relics-list");
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
  const wrap = $("gadgets-list");
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

function renderExcludeList() {
  const wrap = $("exclude-list");
  if (!wrap || !state.weaponBonuses) return;
  wrap.innerHTML = "";
  const sections = [
    ["Weapon bonuses", state.weaponBonuses.bonuses.map(b => ["bonus:" + b.id, b.name])],
    ["Relics", state.relics.relics.map(r => ["relic:" + r.id, `${r.power} (${r.name})`])],
    ["Gadget parts", [...new Set(state.gadgetsIndex.flatMap(g =>
      state.gadgetData[g.id].parts.map(p => JSON.stringify(["part:" + p.id, p.name]))))]
      .map(s => JSON.parse(s))],
    ["Tank power", [["power", "Activate Tank Power"]]],
  ];
  for (const [title, items] of sections) {
    const h = document.createElement("h4");
    h.textContent = title;
    wrap.appendChild(h);
    for (const [key, name] of items) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = state.maxExclude.has(key);
      box.addEventListener("change", () => {
        if (box.checked) state.maxExclude.add(key);
        else state.maxExclude.delete(key);
        updateExcludeSummary();
        saveState();
      });
      label.append(box, document.createTextNode(name));
      wrap.appendChild(label);
    }
  }
  updateExcludeSummary();
}

const ANCHOR_IDS = ["player", "tank", "weapon-card", "relics", "gadgets",
                    "enemy-status", "maximize-damage", "attacks-card", "damage"];

function addAnchorLinks() {
  for (const id of ANCHOR_IDS) {
    const section = document.getElementById(id);
    const heading = section && section.querySelector(".chip");
    if (!heading) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "anchor-link";
    btn.textContent = "#";
    btn.title = "Copy link to this section";
    btn.setAttribute("aria-label", "Copy link to this section");
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const url = `${location.origin}${location.pathname}#${id}`;
      try { await navigator.clipboard.writeText(url); }
      catch (err) { window.prompt("Copy this link:", url); return; }
      btn.textContent = "\u2713";
      setTimeout(() => { btn.textContent = "#"; }, 1200);
    });
    // the player chip is itself a button pill; place the anchor beside it
    if (heading.classList.contains("chip-name")) heading.after(btn);
    else heading.appendChild(btn);
  }
}

function updateExcludeSummary() {
  const n = state.maxExclude.size;
  $("exclude-summary").textContent = n ? `Exclude buffs (${n} excluded)` : "Exclude buffs";
}

/* ---------- apply a saved/linked build ---------- */

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
