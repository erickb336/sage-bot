// The projects of the config (T132). loadProjects checks them and resolves each one once, when the config loads, to one identity: the
// real path of its folder, in the letter case of the disk. The bridge, the hook, /sage, vote.mjs, reasons.mjs, launchd.mjs and
// channels.mjs name a project only through loadProjects, pickProject and projectAt, so they all name a folder the same way (G43 A).
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { forTerminal } from './clean.js';

export const TYPES = ['png', 'jpg', 'svg', 'pdf'];
/** A project name: also the value of the slash command's project choice. */
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** One allow-listed file or glob, relative to the project: folders and a file name of safe characters, `*` only in the file name. */
const DIR_PART = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const FILE_PART = new RegExp(`^[A-Za-z0-9_*-][A-Za-z0-9_.*-]*\\.(?:${TYPES.join('|')})$`);
/** A GitHub repository, for the link of a pull request. */
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * The checks of the config's projects, before the disk (loadProjects resolves them): `projects`, `projects`, or else the bridge's own project with no files. Throws a TypeError that
 * names the field for a config that is not safe: a name that is not lower-case letters, digits and dashes, a path that is not absolute,
 * a file entry that leaves the project or is not a .png, .jpg, .svg or .pdf.
 * @returns {{ name: string, project: string, sagePath: string, files: string[], repo?: string }[]}
 */
export function projectsOf(config) {
  const fallback = config.projects === undefined;
  if (fallback) {
    // No projects: the bridge's own project, named after its folder. A folder name that makes no valid name says what to add (F-T71Q-5).
    if (typeof config.project !== 'string' || !isAbsolute(config.project)) throw new TypeError('the config: project must be an absolute path');
    const folder = basename(config.project);
    const name = folder.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!NAME.test(name)) {
      throw new TypeError(`the config has no projects, and the folder name of project (${JSON.stringify(forTerminal(folder))}) makes no valid project name: add a projects entry with a name of lower-case letters, digits and dashes (at most 32)`);
    }
    config = { ...config, projects: [{ name, project: config.project, files: [] }] };
  }
  const list = config.projects;
  if (!Array.isArray(list) || list.length < 1 || list.length > 25) throw new TypeError('the config needs projects as a list of 1 to 25 projects');
  const names = new Set();
  return list.map((p, n) => {
    const at = fallback ? 'the config: ' : `projects[${n}].`; // with no projects, a message names the field that the owner wrote
    const sagePath = p.sagePath ?? config.sagePath;
    if (!NAME.test(p.name ?? '') || names.has(p.name)) throw new TypeError(`${at}name must be a new name of lower-case letters, digits and dashes (at most 32)`);
    names.add(p.name);
    for (const [key, path] of [['project', p.project], ['sagePath', sagePath]]) {
      if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError(`${at}${key} must be an absolute path`);
    }
    const files = p.files ?? [];
    if (!Array.isArray(files)) throw new TypeError(`${at}files must be a list`);
    for (const f of files) {
      const parts = String(f).split('/');
      if (typeof f !== 'string' || !parts.slice(0, -1).every((d) => DIR_PART.test(d) && !d.includes('*')) || !FILE_PART.test(parts.at(-1))) {
        throw new TypeError(`${at}files: ${JSON.stringify(f)} must be a path in the project, such as "docs/*.svg", with no "..", and end in .${TYPES.join(', .')}`);
      }
    }
    if (p.repo !== undefined && !REPO.test(p.repo)) throw new TypeError(`${at}repo must be https://github.com/<owner>/<name>`);
    return { name: p.name, project: p.project, sagePath, files, ...(p.repo && { repo: p.repo }) };
  });
}

/** The real path of a folder as the disk spells it, its letter case too, or undefined when there is none. */
const onDisk = (path) => { try { return realpathSync.native(path); } catch { return undefined; } };

/**
 * The projects of the config, each with `project` set to its identity: the real path of its folder as the disk spells it. The own project
 * (the one whose folder is the config's `project`) has `own: true`. Throws one line that ends "Nothing changed." (or "Nothing was
 * started." for the own project) for a config that the bridge cannot serve, so every caller stops before it reads or writes anything:
 * - a listed folder that does not exist (F-T132-14);
 * - a listed path that differs from its folder on disk only in letter case (F-T132-18);
 * - two names for one folder, also by a symlink;
 * - a config `project` that no listed project has (F-T132-1).
 * @returns {{ name: string, project: string, sagePath: string, files: string[], repo?: string, own?: true }[]}
 */
export function loadProjects(config) {
  const seen = new Map();
  const projects = projectsOf(config).map((p) => {
    const real = statSync(p.project, { throwIfNoEntry: false })?.isDirectory() && onDisk(p.project);
    if (!real) throw new Error(`the folder of project ${p.name} (${p.project}) does not exist. Fix its path in projects, or take the project out. Nothing changed.`);
    const written = realpathSync(p.project); // the links resolved, in the letter case of the config
    if (written !== real && written.toLowerCase() === real.toLowerCase()) {
      throw new Error(`the path of project ${p.name} (${p.project}) differs only in letter case from its folder on disk (${real}). Write it as the disk spells it. Nothing changed.`);
    }
    const twin = seen.get(real);
    if (twin) throw new Error(`projects ${twin.name} (${twin.project}) and ${p.name} (${p.project}) are the same folder (${real}). Keep one of them. Nothing changed.`);
    seen.set(real, p);
    return { ...p, project: real };
  });
  const at = typeof config.project === 'string' ? onDisk(config.project) : undefined;
  const own = projects.find((p) => p.project === at);
  if (!own) throw new Error(`the config's project (${config.project ?? 'missing'}) is not in its projects. Add it to projects, with a name. Nothing was started.`);
  own.own = true;
  return projects;
}

/**
 * The project named `name` (loadProjects), or the own project when `name` is undefined. Throws for a name that the config does not list.
 * @param {ReturnType<typeof loadProjects>} projects
 */
export function pickProject(projects, name) {
  const p = name === undefined ? projects.find((x) => x.own) : projects.find((x) => x.name === name);
  if (!p) throw new Error(`the project "${name}" is not in the config's projects (${projects.map((x) => x.name).join(', ')}). Nothing changed.`);
  return p;
}

/**
 * The listed project of a folder (loadProjects): the deepest project whose folder holds it, by the real path as the disk spells it.
 * A path that does not exist is taken as written.
 * @param {ReturnType<typeof loadProjects>} projects
 */
export function projectAt(path, projects) {
  const at = onDisk(path) ?? resolve(path);
  const holds = (p) => { const rel = relative(p.project, at); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }; // '..cache' is inside (F-T29-11)
  return projects.filter(holds).sort((a, b) => b.project.length - a.project.length)[0];
}
