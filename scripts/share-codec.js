"use strict";

/* Compact share codec (v1): the whole build bit-packed into ~15 bytes.
   The tables below are the codec's fixed vocabulary; they are APPEND-ONLY.
   Reordering or removing entries breaks every link in the wild, so new
   weapons/relics/bonuses/parts must be added at the END of their list. */
const SHARE_TANKS = ["power", "speed", "tactic"];
const SHARE_RANGE = ["", "close", "long"];
const SHARE_WEAPONS = [
  "splattershot", "splattershot-jr", "squelcher", "splat-roller",
  "dynamo-roller", "e-liter", "squiffer", "slosher", "sloshing-machine",
  "heavy-splatling", "mini-splatling", "splat-dualies", "glooga-dualies",
  "splat-brella", "tenta-brella", "blaster", "rapid-blaster-pro",
  "octobrush", "tri-stringer", "splatana-stamper",
];
const SHARE_BONUSES = ["long-range", "close-combat", "ice-breaker",
                       "risky-reward", "concentrated-attack"];
const SHARE_RELICS = ["regal-scepter", "antique-corkscrew", "family-size-cutter",
                      "bronze-press", "distant-gazer", "ancient-salmon-run-slab"];
const SHARE_PARTS = ["blast_boot/damage-surge", "dash_bomb/damage-surge",
                     "jump_bomb/airborne-damage-up", "flywire/damage-surge",
                     "flywire/airborne-damage-up"];
const SHARE_FLAGS = ["danger", "airborne", "hpfull", "inkspent", "frozen", "ferment"];

function bitWriter() {
  const bits = [];
  return {
    push(value, width) {
      for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
    },
    bytes() {
      const out = new Uint8Array(Math.ceil(bits.length / 8));
      bits.forEach((b, i) => { if (b) out[i >> 3] |= 128 >> (i & 7); });
      return out;
    },
  };
}

function bitReader(bytes) {
  let pos = 0;
  return {
    read(width) {
      let v = 0;
      for (let i = 0; i < width; i++, pos++)
        v = v * 2 + ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
      return v;
    },
  };
}

function encodeCompact(snap) {
  if (Object.keys(snap.gadgetPartSel).some(k => !SHARE_PARTS.includes(k)))
    return null;  // selection the codec tables don't know yet
  const wi = SHARE_WEAPONS.indexOf(snap.weapon);
  if (wi < 0) return null;
  const inp = snap.inputs;
  const w = bitWriter();
  w.push(1, 4);  // codec version
  w.push(Math.max(0, SHARE_TANKS.indexOf(snap.tankId)), 2);
  w.push(wi, 6);
  w.push(Math.min(3, +inp.attack || 0), 2);
  w.push(Math.min(63, +inp.pbase || 50), 6);
  w.push(Math.min(9999, +inp.pextra || 0), 14);
  w.push(Math.min(63, +inp.wbase || 50), 6);
  w.push(Math.min(63, +inp.wplus || 0), 6);
  w.push(Math.min(200, +inp.tankbonus || 0), 8);
  w.push(Math.min(400, +inp.hpbonus || 0), 9);
  w.push(Math.max(0, SHARE_RANGE.indexOf(inp.range || "")), 2);
  for (const id of SHARE_FLAGS) w.push(inp[id] === "1" ? 1 : 0, 1);
  w.push(inp.streak === "3" ? 1 : 0, 1);
  for (const id of SHARE_RELICS) w.push(snap.relicLevels[id] || 0, 2);
  for (const id of SHARE_BONUSES) w.push(snap.weaponBonusLevels[id] || 0, 2);
  for (const key of SHARE_PARTS) {
    const idx = snap.gadgetPartSel[key];
    w.push(idx === undefined ? 0 : 1, 1);
    w.push(idx === undefined ? 0 : Math.min(15, idx), 4);
  }
  const bytes = w.bytes();
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCompact(str) {
  try {
    let s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    if (bin.length > 40) return null;  // legacy JSON blobs are far longer
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const r = bitReader(bytes);
    if (r.read(4) !== 1) return null;
    const snap = { inputs: {}, relicLevels: {}, weaponBonusLevels: {}, gadgetPartSel: {} };
    snap.tankId = SHARE_TANKS[r.read(2)] || "speed";
    snap.weapon = SHARE_WEAPONS[r.read(6)];
    snap.inputs.attack = String(r.read(2));
    snap.inputs.pbase = String(r.read(6));
    snap.inputs.pextra = String(r.read(14));
    snap.inputs.wbase = String(r.read(6));
    snap.inputs.wplus = String(r.read(6));
    snap.inputs.tankbonus = String(r.read(8));
    snap.inputs.hpbonus = String(r.read(9));
    snap.inputs.range = SHARE_RANGE[r.read(2)] || "";
    for (const id of SHARE_FLAGS) snap.inputs[id] = String(r.read(1));
    snap.inputs.streak = r.read(1) ? "3" : "0";
    for (const id of SHARE_RELICS) {
      const lvl = r.read(2);
      if (lvl) snap.relicLevels[id] = lvl;
    }
    for (const id of SHARE_BONUSES) {
      const lvl = r.read(2);
      if (lvl) snap.weaponBonusLevels[id] = lvl;
    }
    for (const key of SHARE_PARTS) {
      const on = r.read(1);
      const idx = r.read(4);
      if (on) snap.gadgetPartSel[key] = idx;
    }
    return snap.weapon ? snap : null;
  } catch (e) { return null; }
}

// legacy fallback: base64url of UTF-8 JSON (old share links still decode)
function encodeBuild(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBuild(str) {
  try {
    let s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  } catch (e) { return null; }
}

function shareURL(snap) {
  const data = { ...snap };
  delete data.playerName;
  const code = encodeCompact(data) || encodeBuild(data);
  return `${location.origin}${location.pathname}` +
         `?build=${code}&name=${encodeURIComponent(snap.playerName)}`;
}
