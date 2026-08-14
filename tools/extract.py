#!/usr/bin/env python3
"""Build data.json for the Raiders damage calculator from Laugh_Lover's
published spreadsheet (see README for source/credit).

Sheet layout, "Weapon damage values" tab:
  rows 0-2   weapon variant names (trios per family)
  row  3     attack names per column ("Splattershot - Shot", ...)
  row  4     per-attack scaling factors
  rows 5-64  block 1: displayed damage, weapon levels 1-60,
             logged by a level-50 player (player damage 4500, tank x3)
  rows 71+   block 2: same columns, weapon levels 50-100,
             logged by a level 50+100 player (player damage 4700, tank x3)

Displayed = (PlayerDamage + BaseWeaponDamage(level)) * factor * tankMult
so each logged cell yields an implied BaseWeaponDamage; we take the median
per level across all weapons (they all share one damage curve) after
rejecting outliers, e.g. mislogged cells.
"""
import csv, json, statistics, sys, urllib.request
from pathlib import Path

BASE = ("https://docs.google.com/spreadsheets/d/e/2PACX-1vThDUSq-3xSdnngXijX_"
        "8sPtEPU2vnnj26uWvLFn5qZmlwnKbl-KDOnJ_2Z0Ix-pdax6XFCW-sl8NmV/pub?output=csv&gid=")
GID_WEAPONS = "624726203"
GID_PLAYER = "1470291803"
TANK = 3.0
PD_BLOCK1, PD_BLOCK2 = 4500.0, 4700.0

here = Path(__file__).resolve().parent
data_dir = here.parent / "data"
raw_dir = data_dir / "source" / "raw"
raw_dir.mkdir(parents=True, exist_ok=True)


def fetch(gid, name):
    path = raw_dir / name
    if not path.exists():
        urllib.request.urlretrieve(BASE + gid, path)
    return list(csv.reader(path.open()))


def write_csv(name, header, rows):
    path = data_dir / name
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    print(f"wrote {path} ({len(rows)} rows)", file=sys.stderr)


def num(cell):
    cell = cell.strip().replace(",", "")
    try:
        return float(cell)
    except ValueError:
        return None


rows = fetch(GID_WEAPONS, "weapon_damage.csv")
attack_row, factor_row = rows[3], rows[4]

# family name = text before the en-dash in the attack name
attacks = []  # (col, family, attack_label, factor)
for j, cell in enumerate(attack_row):
    f = num(factor_row[j]) if j < len(factor_row) else None
    if not cell.strip() or f is None:
        continue
    name = cell.strip().replace("Tri-Sringer", "Tri-Stringer")  # sheet typo
    if "–" in name:
        family, label = [p.strip() for p in name.split("–", 1)]
    else:
        family, label = name, "Attack"
    attacks.append((j, family, label, f))

# variant trios per family column (rows 0-2 hold the three variant names)
variants = {}
for j, fam, _, _ in attacks:
    trio = [rows[i][j].strip() for i in range(3) if j < len(rows[i]) and rows[i][j].strip()]
    if trio:
        variants.setdefault(fam, trio)

BLOCKS = [(5, 65, PD_BLOCK1), (71, len(rows), PD_BLOCK2)]


def cells():
    """Yield (level, col, displayed, player_damage) for every logged cell."""
    for start, end, pd in BLOCKS:
        for r in rows[start:end]:
            if not r or num(r[0]) is None:
                continue
            lvl = int(num(r[0]))
            for j, _, _, f in attacks:
                d = num(r[j]) if j < len(r) else None
                if d is not None:
                    yield lvl, j, d, pd


def solve_base(factors):
    """Median implied base weapon damage per level, outliers rejected."""
    obs = {}
    for lvl, j, d, pd in cells():
        obs.setdefault(lvl, []).append(d / (factors[j] * TANK) - pd)
    base = {}
    for lvl, vals in sorted(obs.items()):
        med = statistics.median(vals)
        kept = [v for v in vals if abs(v - med) <= max(0.01 * abs(med), 2)]
        base[lvl] = statistics.median(kept)
    return base


# First pass with the sheet's factor row, then re-fit each column's factor
# from its own logged cells (the sheet's Heavy Splatling factor is a known
# 3x transcription error) and solve again with the fitted factors.
factors = {j: f for j, _, _, f in attacks}
base = solve_base(factors)
for j, fam, label, f in attacks:
    ratios = [d / ((pd + base[lvl]) * TANK) for lvl, c, d, pd in cells() if c == j]
    if ratios:
        fitted = round(statistics.median(ratios), 3)
        if abs(fitted - f) / f > 0.005:
            print(f"  factor corrected: {fam} - {label}: {f} -> {fitted}", file=sys.stderr)
        factors[j] = fitted
attacks = [(j, fam, label, factors[j]) for j, fam, label, _ in attacks]
base = {lvl: round(v, 2) for lvl, v in solve_base(factors).items()}

missing = [l for l in range(1, 101) if l not in base]
if missing:
    sys.exit(f"missing weapon levels: {missing}")

# player HP and damage per level (base HP / DMG columns), levels 1-50;
# past 50 ("50 +N") each level gives +0.5 HP and +2 damage
prows = fetch(GID_PLAYER, "player_level.csv")
player, hp = {}, {}
for r in prows:
    lvl = num(r[0])
    dmg = num(r[2]) if len(r) > 2 else None
    h = num(r[1]) if len(r) > 1 else None
    if lvl is not None and dmg is not None and 1 <= lvl <= 50:
        player[int(lvl)] = int(dmg)
        hp[int(lvl)] = h
assert sorted(player) == list(range(1, 51)) and player[50] == 4500, "player table unexpected"

# round-trip check: recompute every logged cell, report worst relative error
errs = sorted(abs((pd + base[lvl]) * factors[j] * TANK - d) / d
              for lvl, j, d, pd in cells())
outliers = sum(1 for e in errs if e >= 0.01)
worst_ok = max((e for e in errs if e < 0.01), default=0.0)
print(f"round-trip: {len(errs)} cells, worst non-outlier error {worst_ok:.4%}, "
      f"{outliers} outlier cell(s) excluded", file=sys.stderr)

families = []
for j, fam, label, f in attacks:
    entry = next((e for e in families if e["name"] == fam), None)
    if entry is None:
        entry = {"name": fam, "variants": variants.get(fam, []), "attacks": []}
        families.append(entry)
    entry["attacks"].append({"label": label, "factor": f})

SOURCE = "Laugh_Lover's spreadsheet, gamefaqs.gamespot.com/boards/540184-splatoon-raiders/81174710"


def slugify(name):
    return "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-").replace("--", "-")


(data_dir / "player_levels.json").write_text(json.dumps({
    "source": SOURCE,
    "levels": [{"level": l, "hp": hp[l], "damage": player[l]} for l in range(1, 51)],
    "postSoftcap": {"hpPerLevel": 0.5, "damagePerLevel": 2, "maxExtra": 9999},
    "tankBonuses": {"weaponDamageMaxPct": 200, "hpMaxPct": 400},
}, indent=1))

weapons_dir = data_dir / "weapons"
weapons_dir.mkdir(exist_ok=True)
index = []
curve = [base[l] for l in range(1, 101)]
for famd in families:
    slug = slugify(famd["name"])
    index.append({"slug": slug, "name": famd["name"], "variants": famd["variants"]})
    (weapons_dir / f"{slug}.json").write_text(json.dumps({
        "source": SOURCE,
        "slug": slug,
        "name": famd["name"],
        "variants": famd["variants"],
        "attacks": famd["attacks"],
        "maxLevel": 100,
        "baseDamage": curve,
    }, indent=1))
(weapons_dir / "index.json").write_text(json.dumps(index, indent=1))
print(f"wrote player_levels.json and {len(families)} weapon files "
      f"({sum(len(f['attacks']) for f in families)} attacks)", file=sys.stderr)

# ---- tidy CSVs (clean tables; raw sheet exports live in data/source/raw) ----

def clean_int(cell):
    v = num(cell)
    return int(v) if v is not None and v == int(v) else v

write_csv("player_levels.csv",
          ["level", "base_hp", "damage", "exp_to_next", "displayed_hp", "tank_hp_pct"],
          [[int(num(r[0])), clean_int(r[1]), clean_int(r[2]), clean_int(r[3]),
            clean_int(r[6]), r[7].strip().rstrip("%")]
           for r in prows
           if num(r[0]) is not None and 1 <= num(r[0]) <= 50 and num(r[2]) is not None])

write_csv("base_weapon_damage.csv", ["weapon_level", "base_damage"],
          [[l, base[l]] for l in range(1, 101)])

write_csv("weapon_factors.csv", ["family", "attack", "factor"],
          [[fam, label, f] for _, fam, label, f in attacks])

attack_by_col = {j: (fam, label) for j, fam, label, _ in attacks}
write_csv("weapon_damage_long.csv",
          ["player_damage", "weapon_level", "family", "attack", "displayed_damage"],
          [[int(pd), lvl, *attack_by_col[j], clean_int(str(d))]
           for lvl, j, d, pd in sorted(cells(), key=lambda c: (c[3], c[0]))])

# spirhalite tab: first block = cumulative shard costs; commentary columns dropped
srows = fetch("948169954", "spirhalite_costs.csv")
cost_rows = []
for r in srows:
    if r and r[0].strip() == "Level" and len(r) > 1 and "individual" in r[1].lower():
        break
    lvl = num(r[0]) if r else None
    if lvl is None or not 1 <= lvl <= 50:
        continue
    for i in range(1, len(r)):
        v = num(r[i])
        if v is None:
            break
        cost_rows.append([int(lvl), i, int(v)])
write_csv("spirhalite_costs.csv", ["base_level", "upgrades", "cumulative_shards"], cost_rows)

# weapon list tab: rows come in trios (/ , family, \)
wrows = fetch("17934013", "weapon_list.csv")
trio, list_rows = [], []
for r in wrows:
    if len(r) >= 3 and r[0].strip() in ("/", "\\") or (len(r) >= 3 and r[1].strip() and r[2].strip() and not r[0].startswith(("There", "each", "(with"))):
        if r[1].strip() and r[2].strip():
            trio.append([r[0].strip(), r[1].strip(), r[2].strip()])
    if len(trio) == 3:
        fam = trio[1][0]
        for _, variant, desc in trio:
            list_rows.append([fam, variant, desc])
        trio = []
write_csv("weapon_list.csv", ["family", "variant", "description"], list_rows)
