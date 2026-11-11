'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function gameDirectory(folder) {
  if (!folder || !path.isAbsolute(folder)) return null;
  try {
    const dir = fs.realpathSync.native(folder);
    if (fs.statSync(path.join(dir, 'TaskBarHero.exe')).isFile() &&
        fs.statSync(path.join(dir, 'TaskBarHero_Data', 'sharedassets0.assets')).isFile()) return dir;
  } catch { /* A Steam library can be offline or the game may have moved. */ }
  return null;
}

function readSteamFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function gameInSteamRoot(root) {
  if (!root || !path.isAbsolute(root)) return null;
  const libraries = new Set([root]);
  const vdf = readSteamFile(path.join(root, 'steamapps', 'libraryfolders.vdf'));
  // New Valve KeyValues files use "path"; older ones list numbered library paths.
  for (const match of vdf.matchAll(/^\s*"(?:path|\d+)"\s+"([^"\r\n]+)"\s*$/gmi)) {
    const library = match[1].replace(/\\\\/g, '\\');
    if (path.isAbsolute(library)) libraries.add(library);
  }
  for (const library of libraries) {
    const apps = path.join(library, 'steamapps');
    const manifest = readSteamFile(path.join(apps, 'appmanifest_3678970.acf'));
    const entry = /^\s*"installdir"\s+"([^"\r\n]+)"/mi.exec(manifest);
    const name = entry && path.basename(entry[1]) === entry[1] ? entry[1] : 'TaskbarHero';
    const found = gameDirectory(path.join(apps, 'common', name));
    if (found) return found;
  }
  return null;
}

function registeredSteamRoots() {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return [];
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const query = [
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    "(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath",
    "(Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam' -ErrorAction SilentlyContinue).InstallPath",
    "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Valve\\Steam' -ErrorAction SilentlyContinue).InstallPath"
  ].join('\n');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding:'utf8', windowsHide:true, timeout:4000
  });
  return (result.stdout || '').split(/\r?\n/).filter(Boolean);
}

function findGameInstall() {
  const selected = process.env.TBH_GAME_DIR;
  if (selected) return gameDirectory(selected);
  const roots = [process.env.TBH_STEAM_ROOT, process.env.SteamPath];
  for (const key of ['ProgramFiles(x86)', 'ProgramFiles']) {
    if (process.env[key]) roots.push(path.join(process.env[key], 'Steam'));
  }
  for (const root of new Set(roots)) {
    const found = gameInSteamRoot(root);
    if (found) return found;
  }
  // The Windows UI passes the registry path directly; CLI users may have custom Steam installs too.
  if (!process.env.TBH_STEAM_ROOT) {
    for (const root of new Set(registeredSteamRoots())) {
      const found = gameInSteamRoot(root);
      if (found) return found;
    }
  }
  return null;
}

module.exports = { findGameInstall };
