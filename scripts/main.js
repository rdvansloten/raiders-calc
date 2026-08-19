"use strict";

// Snapshot application and boot wiring. Must load last.

const INPUT_DEFAULTS = { pbase: "50", pextra: "0", wbase: "50", wplus: "50",
                         tankbonus: "200", hpbonus: "400", range: "", danger: "0",
                         airborne: "0", streak: "0", hpfull: "1", inkspent: "0",
                         frozen: "0", ferment: "0", tankpower: "1",
                         "pin-tank": "free", "pin-weapon": "pin", attack: "0" };

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
    state.maxExclude = new Set(Array.isArray(saved.maxExclude)
      ? saved.maxExclude.filter(k => typeof k === "string") : []);
  }
  renderExcludeList();

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
  addAnchorLinks();

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
  $("maximize").addEventListener("click", maximizeDamage);
  $("copy-link-create").addEventListener("click", copyCurrentLink);
  $("danger").addEventListener("input", () => {
    if ($("danger").value === "1") $("hpfull").value = "0";
  });
  $("hpfull").addEventListener("input", () => {
    if ($("hpfull").value === "1") $("danger").value = "0";
  });
  $("weapon").addEventListener("change", async () => { await loadWeapon($("weapon").value); update(); });
  ["attack", "pbase", "pextra", "wbase", "wplus", "tankbonus", "hpbonus", "range",
   "danger", "airborne", "streak", "hpfull", "inkspent", "frozen", "ferment",
   "tankpower", "pin-tank", "pin-weapon"]
    .forEach(id => $(id).addEventListener("input", update));
}

fitTitle();
boot().catch(err => {
  $("result").textContent = "Failed to load";
  $("breakdown").textContent = String(err) +
    ". Serve this folder over HTTP (e.g. `python3 -m http.server`); file:// blocks data loading.";
});
