'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const sizeLimit = 96 * 1024 * 1024;
const templates = new Set(['note', 'thesis']);
const metadataFields = ['titleEn', 'author', 'advisor', 'discipline', 'school', 'date', 'major', 'studentID', 'advisorEn', 'authorEn', 'disciplineEn', 'schoolEn', 'dateEn', 'abstract'];
const projectFile = 'project.moye';

async function readJson(file) {
  try {
    if ((await fs.stat(file)).size > sizeLimit) throw new Error('文件超过 96 MB');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeAtomic(file, content) {
  const temp = path.join(path.dirname(file), '.moye-' + randomUUID() + '.tmp');
  try {
    await fs.writeFile(temp, content, { flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

function validProject(input) {
  if (input?.format !== 1 || typeof input.text !== 'string' || input.text.length > 600000 ||
      typeof input.title !== 'string' || input.title.length > 240 ||
      !templates.has(input.template) || !['auto', 'none'].includes(input.numbering) ||
      !Array.isArray(input.images) || input.images.length > 120 ||
      !Array.isArray(input.references) || input.references.length > 2500) {
    throw new Error('墨页工程格式无效，或超出支持的项目大小');
  }

  let size = 0;
  for (const item of input.images) {
    if (!item || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || typeof item.name !== 'string' ||
        typeof item.data !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.data)) {
      throw new Error('工程含不受支持的图片');
    }
    size += item.data.length;
  }
  for (const item of input.references) {
    if (!item || !/^[A-Za-z0-9_:.+\/-]{1,120}$/.test(item.key) || typeof item.bib !== 'string' ||
        typeof item.title !== 'string' || typeof item.author !== 'string' || typeof item.id !== 'string') {
      throw new Error('工程含无效的参考文献记录');
    }
    size += item.bib.length;
  }
  if (size > 85 * 1024 * 1024) throw new Error('工程资源超过 85 MB');

  const metadata = {};
  for (const field of metadataFields) {
    const value = input.metadata?.[field];
    if (value == null) continue;
    if (typeof value !== 'string' || value.length > (field === 'abstract' ? 4000 : 240)) throw new Error('论文信息超出允许长度');
    metadata[field] = value.trim();
  }
  return {
    format: 1, title: input.title, text: input.text.replace(/\r\n?/g, '\n'), template: input.template,
    numbering: input.numbering, metadata, images: input.images, references: input.references
  };
}

function readProject(input) {
  if (['journal', 'report'].includes(input?.template)) return validProject({ ...input, template: 'note' });
  return validProject(input);
}

function safeName(value) {
  const clean = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 75).replace(/[. ]+$/, '');
  return !clean || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(clean) ? '未命名文档' : clean;
}

function nestedPath(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error('文件路径超出工程范围');
  return target;
}

async function exists(file) {
  return fs.lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function physicalDirectory(directory) {
  const stat = await exists(directory);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('工程目录必须是实际文件夹');
  return stat;
}

function createWorkspace(root, userData) {
  async function directory(id) {
    if (typeof id !== 'string' || !id || id.startsWith('.moye-') || id !== path.basename(id) || /[<>:"/\\|?*\x00-\x1f]/.test(id)) {
      throw new Error('文档编号无效');
    }
    const target = nestedPath(root, id);
    if (!await physicalDirectory(target)) throw new Error('文档文件夹不存在');
    return target;
  }

  async function list() {
    const projects = [];
    for (const item of await fs.readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('.moye-')) continue;
      const project = await exists(path.join(root, item.name, projectFile));
      if (project?.isFile()) projects.push({ id: item.name, name: item.name });
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  }

  async function load(id) {
    const file = path.join(await directory(id), projectFile);
    if (!(await exists(file))?.isFile()) throw new Error('找不到文档工程文件');
    return readProject(await readJson(file));
  }

  async function save(id, project) {
    const file = path.join(await directory(id), projectFile);
    await writeAtomic(file, JSON.stringify(project));
  }

  async function create(project) {
    const name = safeName(project.title);
    for (let suffix = 1; suffix < 10000; suffix++) {
      const id = suffix === 1 ? name : name + ' (' + suffix + ')';
      const folder = nestedPath(root, id);
      try {
        await fs.mkdir(folder);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      try {
        await save(id, project);
        await fs.mkdir(path.join(folder, 'source'));
        return id;
      } catch (error) {
        // This folder was reserved by this call. Leave a recoverable project if a write succeeded.
        await fs.rmdir(folder).catch(() => {});
        throw error;
      }
    }
    throw new Error('同名文档太多，请换一个标题');
  }

  async function importFile(file) {
    const folder = path.dirname(file);
    const inside = path.dirname(folder).toLowerCase() === root.toLowerCase() && path.basename(file).toLowerCase() === projectFile;
    if (inside) {
      const id = path.basename(folder);
      return { id, project: await load(id) };
    }
    const project = readProject(await readJson(file));
    return { id: await create(project), project };
  }

  function cache(id) {
    const key = createHash('sha256').update(id ?? 'scratch').digest('hex').slice(0, 28);
    return path.join(userData, 'build', key);
  }

  async function publish(id, result) {
    const folder = await directory(id);
    const source = path.join(folder, 'source');
    const previous = await physicalDirectory(source);
    const stage = await fs.mkdtemp(path.join(folder, '.moye-output-'));
    const next = path.join(stage, 'source');
    const backup = path.join(stage, 'previous');
    let backedUp = false;
    let movedNext = false;
    let committed = false;

    try {
      await fs.mkdir(next);
      for (const relative of result.sourceFiles) {
        const from = nestedPath(result.workDir, relative);
        const to = nestedPath(next, relative);
        if (!(await fs.lstat(from)).isFile()) throw new Error('LaTeX 源文件无效');
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
      }
      const bytes = await fs.readFile(result.pdfPath);
      if (previous) {
        await fs.rename(source, backup);
        backedUp = true;
      }
      await fs.rename(next, source);
      movedNext = true;
      await writeAtomic(path.join(folder, '正文.pdf'), bytes);
      committed = true;
    } finally {
      if (!committed) {
        if (movedNext) await fs.rename(source, next).catch(() => {});
        if (backedUp) {
          try { await fs.rename(backup, source); backedUp = false; } catch {}
        }
      } else if (backedUp) {
        // Source is regenerated on each successful build. Preserve the previous editable tree.
        const recovery = path.join(userData, 'previous-source');
        const target = path.join(recovery, path.basename(cache(id)));
        try {
          await fs.mkdir(recovery, { recursive: true });
          const old = await physicalDirectory(target);
          if (old) {
            const previousBackup = path.join(stage, 'older');
            await fs.rename(target, previousBackup);
          }
          await fs.rename(backup, target);
          backedUp = false;
        } catch {}
      }
      if (!backedUp) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function removeAssetCopies(id, asset, remaining) {
    // Keep a shared binary until its last attachment is removed.
    if (remaining.some(item => item.data === asset.data)) return;
    const data = Buffer.from(asset.data.slice(asset.data.indexOf(',') + 1), 'base64');
    const digest = createHash('sha256').update(data).digest('hex');
    const cacheRoot = cache(id);
    const directories = [];
    if (id) {
      directories.push(path.join(await directory(id), 'source'));
      directories.push(path.join(userData, 'previous-source', path.basename(cacheRoot)));
    }
    if (await physicalDirectory(cacheRoot)) {
      for (const entry of await fs.readdir(cacheRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^compile-[A-Za-z0-9]+$/.test(entry.name)) directories.push(path.join(cacheRoot, entry.name));
      }
    }
    const allowed = await Promise.all([root, userData].map(directory => fs.realpath(directory)));
    for (const folder of directories) {
      if (!await physicalDirectory(folder)) continue;
      const realFolder = await fs.realpath(folder);
      if (!allowed.some(directory => realFolder.startsWith(directory + path.sep))) throw new Error('附件目录超出工程范围');
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !/^image-\d+\.(png|jpg)$/i.test(entry.name)) continue;
        const candidate = nestedPath(folder, entry.name);
        const stat = await fs.lstat(candidate);
        if (!stat.isFile() || stat.size !== data.length) continue;
        if (createHash('sha256').update(await fs.readFile(candidate)).digest('hex') === digest) {
          await fs.unlink(candidate);
        }
      }
    }
  }

  return { root, directory, list, load, save, create, importFile, cache, publish, removeAssetCopies };

}

module.exports = { readJson, writeAtomic, validProject, readProject, safeName, nestedPath, createWorkspace };
