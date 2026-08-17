#!/usr/bin/env python3
"""Scrape Inkipedia gadget pages -> data/gadgets/<gadget>.json.

Keeps ONLY parts that directly increase damage (e.g. 'Slash Damage Up',
'Airborne Damage Up', 'Damage Surge'), not utility/area/knockback parts.
Each part has variants: (stars, slots, pct) combinations from the wiki table,
sorted ascending by pct so the UI can step through them.

Pages are cached in data/wiki_cache/ (Inkipedia 403s default urllib UA, so we
send a browser UA). Re-run with --refresh to re-download.
"""
import json, re, sys, html as H, urllib.request
from pathlib import Path

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# gadget -> tank, from https://splatoonwiki.org/wiki/Gadget section lists
GADGETS = {
    "Blast_Boot": "speed", "Dash_Bomb": "speed", "Booyarang": "speed",
    "Jump_Bomb": "speed", "Flywire": "speed",
    "Splatchet": "power", "Spinwheel": "power", "Splatellites": "power",
    "Meteor_Mitt": "power", "Shellacker": "power",
    "Shot_Pot": "tactic", "Hi-Fiver": "tactic", "Bombloons": "tactic",
    "Tether_Wail": "tactic", "Torqscrew": "tactic",
}

# The calculator models PLAYER WEAPON damage, so only parts that boost the
# player's damage qualify; the wiki descriptions say "weapon damage" or
# "all damage" for those. Parts that boost the gadget's own damage
# ("Increases Spinwheel damage", "shot damage", etc.) are out of scope.
PLAYER_DAMAGE_RE = re.compile(r"weapon damage|all damage", re.I)

# parts that only apply under a player status (checked by the app)
PART_REQUIRES = {"Airborne Damage Up": "airborne"}


def is_damage_part(name, description):
    return bool(PLAYER_DAMAGE_RE.search(description))


def slug(s):
    return re.sub(r"-+", "-", "".join(c if c.isalnum() else "-" for c in s.lower())).strip("-")


def fetch(page, cache_dir, refresh=False):
    path = cache_dir / f"{page}.html"
    if refresh or not path.exists():
        req = urllib.request.Request(f"https://splatoonwiki.org/wiki/{page}",
                                     headers={"User-Agent": UA})
        path.write_bytes(urllib.request.urlopen(req).read())
    return path.read_text()


def celltext(c):
    c = re.sub(r"<[^>]+>", "", c)
    return H.unescape(c).strip()


def parse_parts(doc):
    """Yield {name, description, developed, upgradable, variants} per part."""
    for table in re.findall(r"<table[^>]*>.*?</table>", doc, re.S):
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S)
        if not rows:
            continue
        head = [celltext(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", rows[0], re.S)]
        if head[:3] != ["Type", "Developed", "Upgradable"]:
            continue
        part = None
        for r in rows[1:]:
            cells = [celltext(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", r, re.S)]
            if len(cells) >= 7:            # new part: name .. first variant
                if part:
                    yield part
                part = {"name": cells[0], "developed": "✓" in cells[1],
                        "upgradable": "✓" in cells[2], "description": cells[3],
                        "variants": []}
                cells = cells[4:7]
            elif part is None or len(cells) < 3:
                continue
            m = re.match(r"(\d)★", cells[0])
            p = re.search(r"([+-]?\d+(?:\.\d+)?)\s*%", cells[2])
            if m and p and cells[1].isdigit():
                part["variants"].append({"stars": int(m.group(1)),
                                         "slots": int(cells[1]),
                                         "pct": float(p.group(1))})
        if part:
            yield part
        return  # only the first matching table per page


def main():
    refresh = "--refresh" in sys.argv
    root = Path(__file__).resolve().parent.parent
    cache = root / "data" / "wiki_cache"
    out = root / "data" / "gadgets"
    cache.mkdir(parents=True, exist_ok=True)
    out.mkdir(exist_ok=True)

    overrides = {}
    override_path = root / "data" / "source" / "gadget_overrides.json"
    if override_path.exists():
        overrides = json.loads(override_path.read_text()).get("overrides", {})

    index = []
    for page, tank in GADGETS.items():
        doc = fetch(page, cache, refresh)
        name = page.replace("_", " ")
        gid = slug(page).replace("-", "_")
        parts = []
        for part in parse_parts(doc):
            if not is_damage_part(part["name"], part["description"]) or not part["variants"]:
                continue
            part["variants"].sort(key=lambda v: (v["pct"], v["slots"]))
            entry = {"id": slug(part["name"]), **part}
            user_variants = overrides.get(gid, {}).get(entry["id"])
            if user_variants:  # user-verified in-game data beats the wiki
                entry["variants"] = sorted(user_variants,
                                           key=lambda v: (v["pct"], v["slots"]))
            if part["name"] in PART_REQUIRES:
                entry["requires"] = PART_REQUIRES[part["name"]]
            parts.append(entry)
        if not parts:
            print(f"  {name}: no damage parts, omitted", file=sys.stderr)
            continue
        (out / f"{gid}.json").write_text(json.dumps({
            "source": f"https://splatoonwiki.org/wiki/{page}",
            "id": gid, "name": name, "tank": tank, "parts": parts,
        }, indent=1))
        index.append({"id": gid, "name": name, "tank": tank,
                      "parts": len(parts)})
        counts = ", ".join(f"{p['name']}({len(p['variants'])})" for p in parts)
        print(f"  {name} [{tank}]: {counts}", file=sys.stderr)

    (out / "index.json").write_text(json.dumps(index, indent=1))
    print(f"wrote {len(index)} gadget files to {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
