'use strict';

// TBH Wiki's farm calculator uses different EXP curves above and below the hero.
function penalty(heroLevel, stageLevel) {
  if (![heroLevel, stageLevel].every(level => Number.isInteger(level) && level > 0)) return null;

  const heroIsHigher = heroLevel >= stageLevel;
  const scale = 1 + Math.log(heroLevel + 1) / 10;
  const freeGap = Math.trunc(scale * (heroIsHigher ? 2 : 5));
  const transition = Math.trunc(scale * (heroIsHigher ? 5 : 6));
  const shoulder = heroIsHigher ? 0.5 : 0.4;
  const gap = Math.abs(heroLevel - stageLevel);
  if (gap <= freeGap) return 1;
  if (gap <= freeGap + transition) {
    const fraction = (gap - freeGap) / transition;
    return 1 - (1 - shoulder) * fraction * fraction;
  }
  const distance = (gap - freeGap - transition) / Math.max(heroLevel / 3, 1);
  return Math.max(0.01, shoulder * (0.01 / shoulder) ** distance);
}

// GameAssembly.dll v1.3.2, SHA-256 e9e3f21ab135f5cc9a344789434e70f32b84c7d2a0ac0789098c19610de877a5.
// StageManager.jeo calls bbh.mki(int,int) at RVA 0x933823. mki (0xB4EC60) selects
// the two parameter sets; mkk (0xB4ED40) implements the float32 Log / Pow curve.
// Its far-gap scale is max(heroLevel / 3, 3). The wiki uses a minimum of 1.
function gamePenaltyV132(heroLevel, stageLevel) {
  if (![heroLevel, stageLevel].every(level => Number.isInteger(level) && level > 0)) return null;
  const f = Math.fround;
  const heroIsHigher = heroLevel >= stageLevel;
  const scale = f(1 + f(f(Math.log(f(heroLevel + 1))) / 10));
  const freeGap = Math.trunc(f(scale * (heroIsHigher ? 2 : 5)));
  const transition = Math.trunc(f(scale * (heroIsHigher ? 5 : 6)));
  const shoulder = f(heroIsHigher ? 0.5 : 0.4);
  const extra = Math.abs(heroLevel - stageLevel) - freeGap;
  if (extra <= 0) return 1;
  if (extra <= transition) {
    const fraction = f(extra / transition);
    return f(1 - f(f(f(1 - shoulder) * fraction) * fraction));
  }
  const floor = f(0.01);
  const distance = f((extra - transition) / Math.max(f(heroLevel / 3), 3));
  return Math.max(floor, f(shoulder * f(Math.pow(f(floor / shoulder), distance))));
}

function validStage(stage) {
  return stage && Number.isFinite(stage.hpEstimate) && stage.hpEstimate > 0 &&
    Number.isFinite(stage.waves) && stage.waves > 0;
}

// Least squares on total HP and wave count, with no intercept.
function wikiModel(anchors) {
  if (!Array.isArray(anchors) || anchors.length < 2) return null;
  const used = new Set();
  let hpSquared = 0, hpWaves = 0, wavesSquared = 0, hpSeconds = 0, waveSeconds = 0;
  for (const anchor of anchors) {
    const { stage, seconds } = anchor || {};
    if (!validStage(stage) || !Number.isFinite(seconds) || seconds <= 0 ||
        !stage.key || used.has(stage.key)) return null;
    used.add(stage.key);
    const { hpEstimate: hp, waves } = stage;
    hpSquared += hp * hp;
    hpWaves += hp * waves;
    wavesSquared += waves * waves;
    hpSeconds += hp * seconds;
    waveSeconds += waves * seconds;
  }

  const determinant = hpSquared * wavesSquared - hpWaves * hpWaves;
  if (Math.abs(determinant) < 0.001) return null;
  let perHp = (hpSeconds * wavesSquared - waveSeconds * hpWaves) / determinant;
  let perWave = (hpSquared * waveSeconds - hpWaves * hpSeconds) / determinant;
  if (perWave < 0) {
    perWave = 0;
    perHp = hpSeconds / hpSquared;
  }
  if (!Number.isFinite(perWave) || !Number.isFinite(perHp) || perHp <= 0) return null;
  return stage => validStage(stage) ? Math.max(1, perHp * stage.hpEstimate + perWave * stage.waves) : null;
}

module.exports = { penalty, gamePenaltyV132, wikiModel };
