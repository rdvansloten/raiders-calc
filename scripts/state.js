"use strict";

const $ = id => document.getElementById(id);

// App state, persistence (localStorage), preset storage, JSON loading.

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
  maxExclude: new Set(),  // buff keys the maximizer must not use
};

/* ---------- persistence ---------- */

const STORAGE_KEY = "raiders-calc-v1";
const SAVED_INPUTS = ["pbase", "pextra", "wbase", "wplus", "tankbonus", "hpbonus",
                      "range", "danger", "airborne", "streak", "hpfull", "inkspent",
                      "frozen", "ferment", "tankpower", "pin-tank", "pin-weapon",
                      "attack"];

function snapshot() {
  const s = { inputs: {}, weapon: $("weapon").value, tankId: state.tankId,
              relicLevels: { ...state.relicLevels },
              gadgetPartSel: { ...state.gadgetPartSel },
              weaponBonusLevels: { ...state.weaponBonusLevels },
              playerName: state.playerName,
              maxExclude: [...state.maxExclude] };
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

async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
