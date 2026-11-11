"""Read TBH stage configuration from Unity TextAsset CSVs. Python 3, standard library."""

import argparse
import json
import os
from collections import Counter
from fractions import Fraction
from pathlib import Path
import tempfile

from game_assets import ROOT, localization_files, read_table, source_stamps, string_lookup

DIFFICULTIES = {"NORMAL": "普通", "NIGHTMARE": "噩梦", "HELL": "地狱", "TORMENT": "折磨"}
METRICS = (
    ("xpEstimate", "RewardExp", "MonsterExpMultiplier", "BossExpMultiplier", 1000),
    ("goldEstimate", "RewardGold", "MonsterGoldMultiplier", "BossGoldMultiplier", 1000),
    ("hpEstimate", "MaxLife", "MonsterHpMultiplier", "BossHpMultiplier", 100),
)


def parse_pool(value):
    pool = {}
    for token in value.split():
        key, weight = token.rsplit("_", 1)
        weight = int(weight)
        if weight <= 0:
            raise ValueError(f"Invalid monster weight {token}")
        pool[key] = pool.get(key, 0) + weight
    return pool


def stage_estimates(stage, level, monsters, pool, denominator):
    mob_count = int(stage["WaveAmount"]) * int(stage["WaveMonsterAmount"])
    boss = monsters[stage["BossMonsterKey"]]
    estimates = {}
    for output, stat, multiplier, boss_multiplier, scale in METRICS:
        weighted = sum(int(monsters[k][stat]) * w for k, w in pool.items() if k in monsters)
        mobs = Fraction(weighted * mob_count, denominator)
        final_boss = Fraction(int(boss[stat]) * int(stage[boss_multiplier]), 1000)
        estimates[output] = round((mobs + final_boss) * int(level[multiplier]) / scale)
    return estimates


def stage_record(row, levels, monsters, local):
    key, stage_type = row["StageKey"], row["STAGETYPE"]
    stage_level, difficulty = row["StageLevel"], row["STAGEDIFFICULITY"]
    pool = parse_pool(row["Monsters"])
    total = sum(pool.values())
    missing = {k: w for k, w in pool.items() if k not in monsters}
    missing_weight = sum(missing.values())
    waves, per_wave = int(row["WaveAmount"] or 0), int(row["WaveMonsterAmount"] or 0)
    name = local(row["StageNameKey"])
    act, number = int(row["Act"]), int(row["StageNo"])
    record = {
        "key": key, "name": name or ("关卡 " + key), "nameKey": row["StageNameKey"],
        "act": act, "no": number, "label": f"{act}-{number}",
        "type": stage_type, "difficulty": difficulty, "difficultyLabel": DIFFICULTIES.get(difficulty, difficulty),
        "level": int(stage_level), "waves": waves, "monstersPerWave": per_wave,
        "enemyCountEstimate": waves * per_wave, "mobKeys": list(pool), "mobWeights": pool,
        "bossKey": row["BossMonsterKey"], "bossMultipliers": {
            k: int(row[k]) if row[k] else None for k in (
                "BossDamageMultiplier", "BossHpMultiplier", "BossGoldMultiplier", "BossExpMultiplier"
            )
        },
        "missingMobWeights": missing, "missingMobWeightFraction": missing_weight / total if total else 0,
        "estimateQuality": "unsupported",
        "xpEstimate": None, "goldEstimate": None, "hpEstimate": None,
    }
    # Separate boss, event and plague gameplay are not calibrated by the regular-stage formula.
    if stage_type == "NORMAL" and total > missing_weight and row["BossMonsterKey"] in monsters:
        level = levels[stage_level]
        record.update(stage_estimates(row, level, monsters, pool, total))
        record["estimateQuality"] = "modeled"
        if missing:
            record["estimateQuality"] = "missing-monster"
            record["estimatesIfMissingRerolled"] = stage_estimates(row, level, monsters, pool, total - missing_weight)
    return record


def read_game(game_dir):
    game_dir = game_dir.resolve()
    data_dir = game_dir / "TaskBarHero_Data"
    version_file = game_dir / "Version.txt"
    asset = data_dir / "sharedassets0.assets"
    locale_files = localization_files(data_dir)
    files = [version_file, asset, *locale_files]
    stamps = source_stamps(game_dir, files)
    version = version_file.read_text(encoding="utf-8-sig").strip()
    blob = asset.read_bytes()
    hashes = {}
    stages = read_table(blob, "StageInfoData", "StageKey", hashes)
    levels = read_table(blob, "StageLevelInfoData", "StageLevel", hashes)
    monsters = read_table(blob, "MonsterInfoData", "MonsterKey", hashes)
    heroes = read_table(blob, "HeroInfoData", "HeroKey", hashes)
    local = string_lookup(*locale_files)
    rows = [stage_record(s, levels, monsters, local) for s in stages.values()]
    names = {key: local(hero["HeroNameKey"]) or f"英雄 {key}" for key, hero in heroes.items()}
    if stamps != source_stamps(game_dir, files):
        raise ValueError("Game assets changed during extraction. Retry after the game update.")
    asset_key = asset.relative_to(game_dir).as_posix()
    return {
        "gameVersion": version, "sourceFile": asset_key, "stageCatalogSchema": 2, "heroNames": names,
        "sourceStamp": stamps[asset_key], "sourceFiles": stamps, "sourceInstallDir": str(game_dir),
        "tableSha256": hashes, "stageTypes": dict(Counter(r["type"] for r in rows)),
        "maxStageLevel": max(r["level"] for r in rows),
        "maxLevelMultiplierEntry": max(map(int, levels)),
        "method": {
            "raw": "关卡类型、难度、等级、波数、每波怪数、怪池权重、Boss 与各项倍率来自本机游戏 CSV。关卡和英雄中文名称取自游戏本地化文件，缺失时显示编号。",
            "estimates": "仅常规战斗关。怪池基础值加权均值 × 波数 × 每波怪数，加上一个 Boss 的基础值 × 对应 Boss 倍率/1000，再乘关卡等级倍率。经验和金币的等级倍率除以1000，生命倍率除以100。结果四舍六入五成双。此算法按 Wiki 口径推算每场期望，未包含个人、临时效果与运行时取整。",
            "missing": "未收录怪物在主估值中保留权重、贡献记零，与 Wiki 口径一致。另附跳过缺项并重抽时的结果。游戏处理缺项的方式尚未证实。",
        },
        "monsters": {k: {c: int(r[c]) for c in ("RewardExp", "RewardGold", "MaxLife", "AttackDamage", "AttackSpeed", "MovementSpeed")}
                     for k, r in monsters.items()},
        "levelMultipliers": {k: {col: int(v) for col, v in r.items() if col != "StageLevel"}
                             for k, r in levels.items()},
        "stages": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path, required=True, help="Steam TaskbarHero installation directory")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "game-stages.json")
    args = parser.parse_args()
    dest = args.out.resolve()
    if dest.is_relative_to(args.game_dir.resolve()):
        parser.error("Choose an output path outside the game installation.")
    data = read_game(args.game_dir)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=dest.parent, suffix=".tmp", delete=False) as tmp:
        name = tmp.name
        try:
            json.dump(data, tmp, ensure_ascii=False, indent=2, allow_nan=False)
            tmp.write("\n")
        except BaseException:
            tmp.close()
            Path(name).unlink(missing_ok=True)
            raise
    try:
        os.replace(name, dest)
    finally:
        Path(name).unlink(missing_ok=True)
    print(f"TBH {data['gameVersion']}: {len(data['stages'])} stages, {len(data['monsters'])} monsters -> {dest}")


if __name__ == "__main__":
    main()
