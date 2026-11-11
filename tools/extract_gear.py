"""Build a gear index from TBH's installed CSV and Chinese Unity string tables."""

import argparse
import json
import os
from pathlib import Path
import re
import struct
import tempfile

from game_assets import ROOT, localization_files, read_table, source_stamps, string_lookup


def item_enum_ids(data_dir):
    """Read literal enum defaults in IL2CPP metadata v31, restricted to gear enums."""
    path = data_dir / "il2cpp_data" / "Metadata" / "global-metadata.dat"
    if not path.is_file():
        return {}, {}
    meta = path.read_bytes()
    if struct.unpack_from("<II", meta) != (0xFAB11BAF, 31):
        return {}, {}
    first_section, = struct.unpack_from("<I", meta, 8)
    header = list(struct.iter_unpack("<II", meta[8:first_section]))

    def section(index):
        off, size = header[index]
        return meta[off:off+size]

    strings, types, fields = section(2), section(19), section(11)
    defaults = {field: off for field, _, off in struct.iter_unpack("<iii", section(7))}
    literals = section(8)

    def name(pool, index):
        return pool[index:pool.index(0, index)].decode("utf-8")

    def literal(off):
        first = literals[off]
        if first < 0x80:
            unsigned = first
        elif first < 0xc0:
            unsigned = ((first & 0x3f) << 8) | literals[off + 1]
        elif first < 0xe0:
            unsigned = ((first & 0x1f) << 24) | int.from_bytes(literals[off+1:off+4], "big")
        else:
            raise ValueError("Unexpected large gear enum literal")
        return (unsigned >> 1) ^ -(unsigned & 1)

    result = {"StatType": {}, "MODTYPE": {}}
    for entry in struct.iter_unpack("<16i8HII", types):
        enum = name(strings, entry[0])
        if enum not in result or name(strings, entry[1]) != "TaskbarHero":
            continue
        for field in range(entry[8], entry[8] + entry[18]):
            key, _, _ = struct.unpack_from("<iiI", fields, field * 12)
            label = name(strings, key)
            if label != "value__":
                result[enum][str(literal(defaults[field]))] = label
    return result["StatType"], result["MODTYPE"]


def gear_record(item, gear, slot, local):
    stats = []
    for i in (1, 2):
        stat = slot.get(f"BaseStat{i}_STATTYPE")
        value = gear.get(f"BaseStat{i}_Value")
        if stat and value and int(value):
            stats.append({"stat": stat, "mod": slot[f"BaseStat{i}_MODTYPE"], "value": int(value), "source": "base"})
    for i in (1, 2, 3):
        stat, value = gear.get(f"InherentStat{i}_STATTYPE"), gear.get(f"InherentStat{i}_Value")
        if stat and stat != "NONE" and value and int(value):
            stats.append({"stat": stat, "mod": gear[f"InherentStat{i}_MODTYPE"], "value": int(value), "source": "inherent"})
    return {"name": local(item["NameKey"]) or item["NameKey"], "grade": item["GRADE"],
            "part": item["PARTS"], "gearType": item["GEARTYPE"], "level": int(item["Level"] or 0),
            "stats": stats, "uniqueMods": [int(k) for k in gear.get("UniqueModKey", "").split()]}


def read_game_gear(game_dir):
    game_dir = game_dir.resolve()
    game_data = game_dir / "TaskBarHero_Data"
    version_file = game_dir / "Version.txt"
    source = game_data / "sharedassets0.assets"
    locale_files = localization_files(game_data)
    metadata = game_data / "il2cpp_data" / "Metadata" / "global-metadata.dat"
    files = [version_file, source, metadata, *locale_files]
    stamps = source_stamps(game_dir, files)
    version = version_file.read_text(encoding="utf-8-sig").strip()
    blob = source.read_bytes()
    hashes = {}

    def table(name, key, grouped=False):
        return read_table(blob, name, key, hashes, grouped=grouped)

    local = string_lookup(*locale_files)
    stat_ids, mod_ids = item_enum_ids(game_data)
    gear_rows = table("GearInfoData", "GearKey")
    slot_rows = table("GearTypeInfoData", "GearType")
    item_rows = table("ItemInfoData", "ItemKey")
    items = {
        key: gear_record(item, gear_rows.get(item["GearKey"], {}), slot_rows.get(item["GEARTYPE"], {}), local)
        for key, item in item_rows.items() if item["ITEMTYPE"] == "GEAR"
    }
    affixes = {}
    for key, rows in table("StatModInfoData", "StatModKey", True).items():
        identity = {(row["STATTYPE"], row["MODTYPE"]) for row in rows}
        if len(identity) != 1:
            raise ValueError(f"Inconsistent stat type across tiers of {key}")
        stat, mode = identity.pop()
        affixes[key] = {"stat": stat, "mod": mode, "tiers": {
            r["Tier"]: [int(r["MinValue"]), int(r["MaxValue"])] for r in rows}}
    uniques = {}
    for key, row in table("UniqueModInfoData", "UniqueModKey").items():
        label = row["UniqueMod"]
        params = [
            {"index": i, "type": row[f"Param{i}ExchangeType"], "value": row[f"Param{i}"],
             "max": row[f"Param{i}_Max"] or None}
            for i in range(1, 6) if row[f"Param{i}"]
        ]
        uniques[key] = {"name": label, "description": local("UniqueMod_" + label), "params": params}
    pet_stats = table("PetStatInfoData", "PetStatKey", True)
    monsters = table("MonsterInfoData", "MonsterKey")
    pets = {}
    for key, r in table("PetInfoData", "PetKey").items():
        unlock = {"type": r["UnlockCondition"], "eventKey": int(r["EventKey"]) if r["EventKey"] else None}
        if unlock["type"] == "KillMonster":
            monster = monsters[r["Param1"]]
            unlock.update(monsterKey=int(r["Param1"]), requiredKills=int(r["Param2"]),
                          monsterName=local(monster["MonsterNameStringKey"]) or monster["MonsterNameStringKey"])
        elif unlock["type"] == "DLC":
            unlock["dlcId"] = int(r["Param1"])
        pets[key] = {"name": local(r["NameKey"]) or r["NameKey"],
                     "description": local(r["DescriptionKey"]), "unlock": unlock, "stats": [
                         {"stat": s["STATTYPE"], "mod": s["MODTYPE"], "value": int(s["Value"])}
                         for s in pet_stats[r["StatDataKey"]]]}

    event_keys = {str(pet["unlock"]["eventKey"]) for pet in pets.values() if pet["unlock"]["eventKey"]}
    pet_events = {}
    if event_keys:
        periods = table("EventPeriodInfoData", "EventKey")
        for event_key in sorted(event_keys):
            period = periods[event_key]
            pet_events[event_key] = {"enabled": period["IsEnabled"].lower() == "true",
                                     "startUtc": period["StartDateUtc"].replace(" ", "T") + "Z",
                                     "endUtc": period["EndDateUtc"].replace(" ", "T") + "Z", "stages": {}}
        stages = table("StageInfoData", "StageKey")
        for stage_key, entry in table("EventStageInfoData", "StageKey").items():
            event = pet_events.get(entry["EventKey"])
            if event is None:
                continue
            stage, ticket = stages[stage_key], item_rows[entry["EntryTicketItemKey"]]
            event["stages"][stage_key] = {
                "name": local(stage["StageNameKey"]) or stage["StageNameKey"],
                "unlockStageKey": int(entry["UnlockStageKey"]), "ticketKey": int(entry["EntryTicketItemKey"]),
                "ticketName": local(ticket["NameKey"]) or ticket["NameKey"], "ticketAmount": int(entry["EntryTicketAmount"])}
    rune_levels = table("RuneLevelInfoData", "LevelKey", True)
    runes = {key: {"name": local(r["NameKey"]) or r["NameKey"], "levels": {
        s["Level"]: {"stat": s["STATTYPE"], "value": int(s["Value"])}
        for s in rune_levels[r["LevelDataKey"]]}} for key, r in table("RuneInfoData", "RuneKey").items()}
    stat_names = set(stat_ids.values()) | {m["stat"] for i in items.values() for m in i["stats"]}
    stat_names |= {m["stat"] for m in affixes.values()}
    stat_names |= {s["stat"] for p in pets.values() for s in p["stats"]}
    stat_names |= {s["stat"] for r in runes.values() for s in r["levels"].values()}
    labels = {s: local("StatName_" + s) or local("AccountStatName_" + s) or s for s in sorted(stat_names)}
    templates = {}
    for stat in sorted(stat_names):
        for mode in ("FLAT", "ADDITIVE", "MULTIPLICATIVE"):
            value = local(f"Stat_{stat}_{mode}")
            if value:
                templates[f"{stat}_{mode}"] = value
        if labels[stat] == stat:
            # Many stat names only have a localized tooltip, e.g. "冰冷伤害 +{0}%".
            template = (templates.get(stat + "_FLAT") or templates.get(stat + "_ADDITIVE")
                        or templates.get(stat + "_MULTIPLICATIVE") or local("AccountStat_" + stat))
            if template:
                text = re.sub(r"\s*[+-]?\{0\}[%％]?\s*$", "", template).strip()
                if text and "{" not in text:
                    labels[stat] = text
    def enum_labels(field, prefixes):
        result = {}
        for label in sorted({i[field] for i in items.values()}):
            result[label] = next((text for prefix in prefixes if (text := local(prefix + label))), label)
        return result
    skills = {k: {"name": local(r["SkillNameKey"]) or r["SkillNameKey"]} for k, r in table("SkillInfoData", "SkillKey").items()}
    if stamps != source_stamps(game_dir, files):
        raise ValueError("The game updated during extraction. Please retry.")
    return {"gameVersion": version, "sourceStamp": stamps[source.relative_to(game_dir).as_posix()],
            "sourceFiles": stamps, "sourceInstallDir": str(game_dir),
            "tableSha256": hashes, "statIds": stat_ids, "modIds": mod_ids,
            "statLabels": labels, "statTemplates": templates, "grades": enum_labels("grade", ["Grade_"]),
            "parts": enum_labels("part", ["ItemParts_", "GearType_"]), "gearTypes": enum_labels("gearType", ["GearType_"]),
            "uniqueMods": uniques, "affixes": affixes, "petUnlockSchema": 1, "petEvents": pet_events,
            "pets": pets, "runes": runes, "skills": skills, "items": items}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "game-gear.json")
    args = parser.parse_args()
    dest = args.out.resolve()
    if dest.is_relative_to(args.game_dir.resolve()):
        parser.error("Choose an output outside the game installation.")
    data = read_game_gear(args.game_dir)
    dest.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=dest.parent, suffix=".tmp", delete=False) as tmp:
            name = Path(tmp.name)
            json.dump(data, tmp, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            tmp.write("\n")
        os.replace(name, dest)
    finally:
        if name:
            name.unlink(missing_ok=True)
    print(f"TBH {data['gameVersion']}: {len(data['items'])} items, {len(data['affixes'])} stat mods -> {dest}")


if __name__ == "__main__":
    main()
