import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';

export const samePath = (left, right) => !!left && !!right && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
export const pathId = (kind, value) => kind + '-' + createHash('sha256').update(path.resolve(value).toLowerCase()).digest('hex').slice(0, 24);

export function parseIni(text) {
  const sections = []; let section;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) { section = { name: heading[1], values: {} }; sections.push(section); continue; }
    const index = line.indexOf('=');
    if (section && index > 0) section.values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return sections;
}

export async function readProfiles(roamingRoot, desktopSource) {
  const root = path.join(roamingRoot, 'zen'), file = path.join(root, 'profiles.ini');
  let source;
  if (desktopSource !== undefined) source = desktopSource;
  else try { source = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { profiles: [], sourceHash: null }; throw error; }
  if (source === null) return { profiles: [], sourceHash: null };
  const sections = parseIni(source), installs = sections.filter(s => s.name.startsWith('Install'));
  const installedDefaults = [...new Set(installs.map(s => s.values.Default).filter(Boolean).map(value => path.resolve(root, value).toLowerCase()))];
  const profiles = [];
  for (const section of sections.filter(s => /^Profile\d+$/.test(s.name))) {
    if (!section.values.Path) continue;
    const directory = section.values.IsRelative === '1' ? path.resolve(root, section.values.Path) : path.resolve(section.values.Path);
    if (profiles.some(profile => samePath(profile.path, directory))) continue;
    let exists = true, accessible = true;
    if (desktopSource === undefined) try { await realpath(directory); } catch (error) { if (error.code === 'ENOENT') exists = false; else if (['EACCES', 'EPERM'].includes(error.code)) accessible = false; else throw error; }
    profiles.push({ id: pathId('profile', directory), name: section.values.Name || 'Zen 配置', path: directory, exists, accessible,
      isDefault: installedDefaults.length ? installedDefaults.length === 1 && installedDefaults[0] === directory.toLowerCase() : section.values.Default === '1' });
  }
  return { profiles, sourceHash: createHash('sha256').update(source).digest('hex') };
}

export function chooseProfile(profiles, preferredId) {
  const available = profiles.filter(p => p.exists && p.accessible !== false);
  if (preferredId && available.some(p => p.id === preferredId)) return preferredId;
  const running = available.filter(p => p.locked);
  if (running.length === 1) return running[0].id;
  if (running.length > 1) return null;
  const defaults = available.filter(p => p.isDefault);
  if (defaults.length === 1) return defaults[0].id;
  return available.length === 1 ? available[0].id : null;
}
