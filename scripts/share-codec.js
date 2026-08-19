"use strict";

/* Compact share codec: the whole build bit-packed into a short base64url token.

   The tables below are the codec's vocabulary and every field is POSITIONAL,
   so the lists are strictly APPEND-ONLY: add new weapons/relics/bonuses/parts
   at the END, and never remove or reorder entries (retire an entry by leaving
   it in place). Since v3 the token records its own table sizes, so links made
   before an addition still decode: options added later simply load unselected,
   selections for entries that no longer resolve are ignored, and the decoder
   flags such links so the app can show an "older build link" notice. */
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
                      "bronze-press", "distant-gazer", "ancient-salmon-run-slab",
                      "golden-pot", "golden-frying-pan",
                      "golden-steamer-set"];  // retired from the app, slot kept
const SHARE_PARTS = ["blast_boot/damage-surge", "dash_bomb/damage-surge",
                     "jump_bomb/airborne-damage-up", "flywire/damage-surge",
                     "flywire/airborne-damage-up"];
// streak is last; it decodes to inputs.streak "3"/"0" instead of "1"/"0"
// tankpower flag = Power surge active; tankferment = Tactical power active
// (links minted when tankpower was a single on/off bit are remapped by tank)
const SHARE_FLAGS = ["danger", "airborne", "hpfull", "inkspent", "frozen",
                     "ferment", "streak", "tankpower", "tankferment"];

// table sizes at the time v1/v2 links were minted; frozen forever so those
// links keep decoding after the live tables grow
const LEGACY_COUNTS = { flags: 7, relics: 6, bonuses: 5, parts: 5 };

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

function flagValue(inp, id) {
  if (id === "streak") return inp.streak === "3" ? 1 : 0;
  if (id === "tankpower")
    return inp.tankpower && inp.tankpower !== "0" ? 1 : 0;
  if (id === "tankferment") return 0;  // retired: power selection is now on/off
  return inp[id] === "1" ? 1 : 0;
}

function setFlag(snap, id, bit) {
  if (id === "streak") { snap.inputs.streak = bit ? "3" : "0"; return; }
  if (id === "tankpower") {
    if (bit) snap.inputs.tankpower = "1";
    else if (!snap.inputs.tankpower) snap.inputs.tankpower = "0";
    return;
  }
  if (id === "tankferment") {
    if (bit) snap.inputs.tankpower = "1";  // legacy per-power links: just "on"
    return;
  }
  snap.inputs[id] = String(bit);
}

function encodeCompact(snap) {
  if (Object.keys(snap.gadgetPartSel).some(k => !SHARE_PARTS.includes(k)))
    return null;  // selection the codec tables don't know yet
  const wi = SHARE_WEAPONS.indexOf(snap.weapon);
  if (wi < 0) return null;
  const inp = snap.inputs;
  const w = bitWriter();
  w.push(3, 4);  // codec version
  w.push(Math.max(0, SHARE_TANKS.indexOf(snap.tankId)), 2);
  w.push(wi, 6);
  w.push(Math.min(3, +inp.attack || 0), 2);
  w.push(Math.min(63, +inp.pbase || 50), 6);
  w.push(Math.min(999, +inp.pextra || 0), 14);
  w.push(Math.min(63, +inp.wbase || 50), 6);
  w.push(Math.min(63, +inp.wplus || 0), 6);
  w.push(Math.min(200, +inp.tankbonus || 0), 8);
  w.push(Math.min(400, +inp.hpbonus || 0), 9);
  w.push(Math.max(0, SHARE_RANGE.indexOf(inp.range || "")), 2);
  // v3: every list is length-prefixed so future table growth can't shift bits
  w.push(SHARE_FLAGS.length, 4);
  for (const id of SHARE_FLAGS) w.push(flagValue(inp, id), 1);
  w.push(SHARE_RELICS.length, 5);
  for (const id of SHARE_RELICS) w.push(snap.relicLevels[id] || 0, 2);
  w.push(SHARE_BONUSES.length, 5);
  for (const id of SHARE_BONUSES) w.push(snap.weaponBonusLevels[id] || 0, 2);
  w.push(SHARE_PARTS.length, 5);
  for (const key of SHARE_PARTS) {
    const idx = snap.gadgetPartSel[key];
    w.push(idx === undefined ? 0 : 1, 1);
    w.push(idx === undefined ? 0 : Math.min(15, idx), 4);
  }
  // player name as length-prefixed UTF-8, capped at 20 characters
  const name = (snap.playerName || "Player").slice(0, 20);
  const nameBytes = unescape(encodeURIComponent(name));
  w.push(Math.min(127, nameBytes.length), 7);
  for (let i = 0; i < Math.min(127, nameBytes.length); i++)
    w.push(nameBytes.charCodeAt(i), 8);
  const bytes = w.bytes();
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCompact(str) {
  try {
    let s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    if (bin.length > 160) return null;  // legacy JSON blobs are far longer
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const r = bitReader(bytes);
    const version = r.read(4);
    if (version < 1 || version > 3) return null;
    const snap = { inputs: {}, relicLevels: {}, weaponBonusLevels: {}, gadgetPartSel: {} };
    let missing = false;  // link predates options that exist now
    snap.tankId = SHARE_TANKS[r.read(2)] || "speed";
    snap.weapon = SHARE_WEAPONS[r.read(6)];
    if (!snap.weapon) snap.weapon = SHARE_WEAPONS[0];  // vanished weapon: ignore
    snap.inputs.attack = String(r.read(2));
    snap.inputs.pbase = String(r.read(6));
    snap.inputs.pextra = String(r.read(14));
    snap.inputs.wbase = String(r.read(6));
    snap.inputs.wplus = String(r.read(6));
    snap.inputs.tankbonus = String(r.read(8));
    snap.inputs.hpbonus = String(r.read(9));
    snap.inputs.range = SHARE_RANGE[r.read(2)] || "";

    const counts = version === 3
      ? { flags: r.read(4), relics: 0, bonuses: 0, parts: 0 }  // read inline below
      : { ...LEGACY_COUNTS };

    const readList = (count, table, apply) => {
      for (let i = 0; i < count; i++) apply(table[i], i);  // undefined id = vanished: ignored
      if (count < table.length) missing = true;            // link predates newer entries
    };

    readList(counts.flags, SHARE_FLAGS, (id) => {
      const bit = r.read(1);
      if (id) setFlag(snap, id, bit);
    });
    for (const id of SHARE_FLAGS.slice(counts.flags)) setFlag(snap, id, 0);

    if (version === 3) counts.relics = r.read(5);
    readList(counts.relics, SHARE_RELICS, (id) => {
      const lvl = r.read(2);
      if (id && lvl) snap.relicLevels[id] = lvl;
    });

    if (version === 3) counts.bonuses = r.read(5);
    readList(counts.bonuses, SHARE_BONUSES, (id) => {
      const lvl = r.read(2);
      if (id && lvl) snap.weaponBonusLevels[id] = lvl;
    });

    if (version === 3) counts.parts = r.read(5);
    readList(counts.parts, SHARE_PARTS, (key) => {
      const on = r.read(1);
      const idx = r.read(4);
      if (key && on) snap.gadgetPartSel[key] = idx;
    });

    if (version >= 2) {
      const len = r.read(7);
      let raw = "";
      for (let i = 0; i < len; i++) raw += String.fromCharCode(r.read(8));
      try { snap.playerName = decodeURIComponent(escape(raw)).slice(0, 20); }
      catch (err) { /* malformed name bytes; keep default */ }
    }
    if (missing) snap.olderVersion = true;
    return snap;
  } catch (e) { return null; }
}

// legacy fallback: base64url of UTF-8 JSON (the oldest share links)
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
  const compact = encodeCompact(snap);  // embeds the player name since v2
  if (compact)
    return `${location.origin}${location.pathname}?build=${compact}`;
  const data = { ...snap };
  delete data.playerName;
  return `${location.origin}${location.pathname}` +
         `?build=${encodeBuild(data)}&name=${encodeURIComponent(snap.playerName)}`;
}
