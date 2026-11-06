'use strict';

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, net, protocol, shell } = require('electron');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { detectTex, compile } = require('./latex.cjs');
const zotero = require('./zotero.cjs');
const { readJson, writeAtomic, validProject, readProject, safeName, nestedPath, createWorkspace } = require('./projects.cjs');

const page = 'moye://local/ui.html';
const formulaKey = 'Shift+4';
const renderer = path.join(__dirname, '..', 'renderer');
const installation = path.dirname(process.execPath);
const templateRoot = app.isPackaged ? path.join(installation, 'template') : path.join(__dirname, '..', 'template');
protocol.registerSchemesAsPrivileged([{
  scheme: 'moye',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);
app.setName('MoTex');
app.setAppUserModelId('Moye.Research');

const installedWorkspace = app.isPackaged && !app.commandLine.hasSwitch('user-data-dir');
if (installedWorkspace) {
  const programData = path.join(installation, 'programdata');
  mkdirSync(programData, { recursive: true });
  app.setPath('userData', programData);
}

let win;
let workspace;
let activeId = null;
let draft;
let draftWrite = Promise.resolve();
let closeRequested = false;
let closeAllowed = false;
let prefs = {};
let lastBuild;
let compiling = false;
let publishing = null;
let removingAsset = false;
let previewDir;
let editorFocused = false;
let formulaKeyRegistered = false;

function releaseFormulaKey() {
  if (formulaKeyRegistered) globalShortcut.unregister(formulaKey);
  formulaKeyRegistered = false;
}

function syncFormulaKey() {
  if (process.platform !== 'win32') return;
  if (!editorFocused || !win?.isFocused() || !win.webContents.isFocused()) {
    releaseFormulaKey();
  } else if (!formulaKeyRegistered) {
    // Windows delivers the registered key before an IME can commit a currency sign.
    formulaKeyRegistered = globalShortcut.register(formulaKey, () => {
      if (editorFocused && win?.isFocused() && win.webContents.isFocused()) win.webContents.send('editor:formula-key');
    });
  }
}

ipcMain.on('editor:focus', (event, focused) => {
  if (event.sender !== win?.webContents || event.senderFrame?.url !== page) return;
  editorFocused = focused === true;
  syncFormulaKey();
});

function userFile(name) {
  return path.join(app.getPath('userData'), name);
}

async function setActive(id, project) {
  await draftWrite.catch(() => {});
  await writeAtomic(userFile('draft.json'), JSON.stringify(id ? { id } : { project }));
  activeId = id;
  draft = project;
  return { id, project, projects: await workspace.list() };
}

function texStatus(bin = prefs.texBin) {
  return detectTex(bin);
}

function fontPreferences(input) {
  const fonts = {};
  const validName = value => typeof value === 'string' && value.length <= 150 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
  for (const key of ['display', 'chinese', 'english', 'symbols']) {
    const family = input?.[key]?.family;
    const local = input?.[key]?.local;
    if (validName(family) && family.trim()) {
      fonts[key] = { family: family.trim(), local: validName(local) ? local.trim() : '' };
    }
  }
  return fonts;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame?.url !== page) {
      return { error: '此窗口无法调用墨页桌面功能' };
    }
    try {
      return await fn(...args);
    } catch (error) {
      return { error: error.message };
    }
  });
}

handle('load', async () => ({
  version: app.getVersion(),
  draft: draft ?? null,
  id: activeId,
  projects: await workspace.list(),
  projectRoot: workspace.root,
  tex: await texStatus(),
  texBin: prefs.texBin || '',
  fontSize: prefs.fontSize || '14',
  fonts: fontPreferences(prefs.fonts)
}));

handle('tex:choose', async () => {
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: '选择包含 xelatex.exe 的 TeX Live bin 目录',
    defaultPath: (await texStatus()).bin || undefined,
    properties: ['openDirectory']
  });
  return filePaths[0] || null;
});

handle('settings:save', async ({ texBin, fontSize, fonts = prefs.fonts }) => {
  if (typeof texBin !== 'string' || texBin.length > 1000 || !['14', '16', '18'].includes(fontSize)) {
    throw new Error('设置格式无效');
  }
  const bin = texBin.trim().replace(/^"(.*)"$/, '$1');
  if (bin && !path.isAbsolute(bin)) throw new Error('请填写 TeX Live bin 的绝对路径');
  const tex = await texStatus(bin);
  const updated = { ...prefs, texBin: bin, fontSize, fonts: fontPreferences(fonts) };
  await writeAtomic(userFile('settings.json'), JSON.stringify(updated, null, 2));
  prefs = updated;
  return { tex, texBin: bin, fontSize, fonts: updated.fonts };
});

handle('project:draft', async ({ project: input, id }) => {
  if (id !== activeId || removingAsset) return false;
  const project = validProject(input);
  const write = draftWrite.catch(() => {}).then(async () => {
    if (id !== activeId) return false;
    if (id) await workspace.save(id, project);
    else await writeAtomic(userFile('draft.json'), JSON.stringify({ project }));
    draft = project;
    return true;
  });
  draftWrite = write;
  return write;
});

handle('project:remove-attachment', async ({ project: input, id, assetId }) => {
  if (id !== activeId || compiling || publishing || removingAsset) throw new Error('请等待当前文档操作结束');
  const project = validProject(input);
  removingAsset = true;
  try {
    await draftWrite.catch(() => {});
    if (id !== activeId) throw new Error('文档已切换');
    const asset = draft?.images.find(item => item.id === assetId);
    if (!asset || project.images.some(item => item.id === assetId)) throw new Error('附件状态已改变');
    if (id) await workspace.save(id, project);
    else await writeAtomic(userFile('draft.json'), JSON.stringify({ project }));
    draft = project;
    let generatedCopiesRemoved = true;
    try {
      await workspace.removeAssetCopies(id, asset, project.images);
    } catch {
      generatedCopiesRemoved = false;
    }
    return { generatedCopiesRemoved };
  } finally {
    removingAsset = false;
  }
});

handle('project:open', async () => {
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: '打开或导入墨页工程',
    defaultPath: workspace.root,
    filters: [{ name: '墨页工程', extensions: ['moye'] }],
    properties: ['openFile']
  });
  if (!filePaths.length) return null;
  const { id, project } = await workspace.importFile(filePaths[0]);
  return setActive(id, project);
});

handle('project:activate', async id => setActive(id, await workspace.load(id)));

handle('project:new', async ({ title, template }) => {
  const project = validProject({ format: 1, title, template, numbering: 'auto', text: '', images: [], references: [] });
  return setActive(await workspace.create(project), project);
});

handle('project:save', async (input, saveAs) => {
  const project = validProject(input);
  if (saveAs || !activeId) return setActive(await workspace.create(project), project);
  await draftWrite.catch(() => {});
  await workspace.save(activeId, project);
  draft = project;
  return { id: activeId, projects: await workspace.list() };
});

handle('project:reveal', async () => {
  const target = activeId ? await workspace.directory(activeId) : workspace.root;
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return true;
});

handle('close:respond', async (approved) => {
  closeRequested = false;
  if (!approved) return false;
  closeAllowed = true;
  await draftWrite.catch(() => {});
  win.close();
  return true;
});

handle('pdf:compile', async (input, projectId) => {
  if (projectId !== activeId) throw new Error('文档已切换');
  if (compiling || removingAsset) throw new Error('正在处理文档，请稍候');
  const project = validProject(input);
  compiling = true;
  try {
    if (publishing) await publishing.catch(() => {});
    const tex = await texStatus();
    if (!tex.ready) throw new Error('请在偏好设置中选择可用的 TeX Live bin 目录');
    const workDir = workspace.cache(projectId);
    await fs.mkdir(workDir, { recursive: true });
    const result = await compile({ ...project, bin: tex.bin, workDir, templateRoot });
    if (!result.ok) return { ok: false, log: result.log };
    const bytes = await fs.readFile(result.pdfPath);
    const id = randomUUID();
    lastBuild = { id, result, projectId };
    return { ok: true, bytes: new Uint8Array(bytes), id, log: result.log, passes: result.passes, reused: result.reused };
  } finally {
    compiling = false;
  }
});

handle('pdf:publish', async id => {
  const build = lastBuild;
  if (!activeId || build?.projectId !== activeId || build.id !== id || compiling || publishing || removingAsset) return false;
  const write = workspace.publish(activeId, build.result);
  publishing = write;
  try {
    await write;
    return true;
  } finally {
    publishing = null;
  }
});

handle('pdf:export', async (id, title) => {
  if (!lastBuild || id !== lastBuild.id || lastBuild.projectId !== activeId) throw new Error('请先生成当前文档的 PDF');
  const bytes = await fs.readFile(lastBuild.result.pdfPath);
  const { filePath } = await dialog.showSaveDialog(win, {
    title: '导出 PDF',
    defaultPath: safeName(title) + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (!filePath) return null;
  await writeAtomic(filePath, bytes);
  return path.basename(filePath);
});

handle('pdf:external', async (id) => {
  if (!lastBuild || id !== lastBuild.id || lastBuild.projectId !== activeId) throw new Error('请先生成当前文档的 PDF');
  const file = path.join(previewDir, 'preview-' + id + '.pdf');
  await fs.copyFile(lastBuild.result.pdfPath, file);
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
  return true;
});

handle('source:export', async (format, input, buildID) => {
  const project = validProject(input);
  const name = safeName(project.title);
  if (format === 'markdown') {
    const { filePath } = await dialog.showSaveDialog(win, {
      title: '导出正文',
      defaultPath: name + '.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (!filePath) return null;
    await writeAtomic(filePath, '# ' + project.title + '\n\n' + project.text + '\n');
    return path.basename(filePath);
  }
  if (format !== 'latex' || lastBuild?.id !== buildID || lastBuild.projectId !== activeId) throw new Error('请先编译当前文档');
  const { result } = lastBuild;
  const payload = [];
  for (const relative of result.sourceFiles) {
    const absolute = nestedPath(result.workDir, relative);
    payload.push([relative, await fs.readFile(absolute)]);
  }
  const { filePaths } = await dialog.showOpenDialog(win, { title: '选择 LaTeX 工程的保存位置', properties: ['openDirectory'] });
  if (!filePaths.length) return null;
  const folder = await fs.mkdtemp(path.join(filePaths[0], name + '-LaTeX-'));
  for (const [relative, bytes] of payload) {
    const file = nestedPath(folder, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  return path.basename(folder);
});

handle('zotero:search', (query, groupID, start, sort, collectionKey) => zotero.search(query, groupID, start, sort, collectionKey));
handle('zotero:collections', groupID => zotero.collections(groupID));
handle('zotero:groups', () => zotero.groups());
handle('zotero:selection', () => zotero.selection());
handle('zotero:export', (item, references) => zotero.cite(item, references));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    await fs.mkdir(userData, { recursive: true });
    for (const name of await fs.readdir(userData)) {
      if (!/^preview-[0-9a-f-]{36}$/.test(name)) continue;
      const stale = path.join(userData, name);
      const info = await fs.lstat(stale).catch(() => null);
      if (info?.isDirectory() && !info.isSymbolicLink()) await fs.rm(stale, { force: true, recursive: true }).catch(() => {});
    }
    previewDir = path.join(userData, 'preview-' + randomUUID());
    await fs.mkdir(previewDir);
    prefs = await readJson(userFile('settings.json')).catch(() => null) || {};
    const projectRoot = path.join(installedWorkspace ? installation : userData, '工程');
    await fs.mkdir(projectRoot, { recursive: true });
    workspace = createWorkspace(projectRoot, userData);
    const last = await readJson(userFile('draft.json')).catch(() => null);
    if (typeof last?.id === 'string') {
      draft = await workspace.load(last.id).catch(() => null);
      if (draft) activeId = last.id;
    } else if (last?.project) {
      try { draft = readProject(last.project); } catch { draft = null; }
      if (draft && (draft.title.trim() || draft.text.trim() || draft.images.length || draft.references.length)) {
        await setActive(await workspace.create(draft), draft);
      }
    }
    if (!draft) {
      const [first] = await workspace.list();
      if (first) await setActive(first.id, await workspace.load(first.id));
    }

    protocol.handle('moye', request => {
      const url = new URL(request.url);
      const target = path.resolve(renderer, '.' + decodeURIComponent(url.pathname));
      if (url.hostname !== 'local' || !target.startsWith(renderer + path.sep)) {
        return new Response(null, { status: 404 });
      }
      return net.fetch(pathToFileURL(target).href);
    });

    win = new BrowserWindow({
      title: '墨页 MoTex',
      width: 1440, height: 940, minWidth: 780, minHeight: 580,
      backgroundColor: '#eff5f7', show: false,
      icon: path.join(__dirname, '..', 'packaging', 'MoTex.ico'),
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true }
    });
    win.removeMenu();
    win.on('focus', syncFormulaKey);
    win.on('blur', releaseFormulaKey);
    win.webContents.on('focus', syncFormulaKey);
    win.webContents.on('blur', releaseFormulaKey);
    win.webContents.on('render-process-gone', () => {
      editorFocused = false;
      releaseFormulaKey();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    const localFontsAllowed = (contents, permission, isMainFrame) => (
      permission === 'local-fonts' && isMainFrame === true && contents === win?.webContents && contents.getURL() === page
    );
    win.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) => (
      (origin === 'moye://local' || origin === 'moye://local/') && localFontsAllowed(contents, permission, details?.isMainFrame)
    ));
    win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(localFontsAllowed(contents, permission, details?.isMainFrame));
    });
    win.on('close', (event) => {
      if (closeAllowed || win.webContents.isCrashed() || win.webContents.isLoadingMainFrame()) return;
      event.preventDefault();
      if (!closeRequested) {
        closeRequested = true;
        win.webContents.send('close:flush');
      }
    });
    win.on('closed', () => {
      editorFocused = false;
      releaseFormulaKey();
      win = undefined;
    });
    win.once('ready-to-show', () => win.show());
    await win.loadURL(page);
  }).catch(error => {
    dialog.showErrorBox('墨页启动失败', error.message);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', releaseFormulaKey);
}

