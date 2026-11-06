'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result?.error) throw new Error(result.error);
  return result;
};
contextBridge.exposeInMainWorld('moye', {
  load: () => invoke('load'),
  chooseTex: () => invoke('tex:choose'),
  saveSettings: settings => invoke('settings:save', settings),
  saveDraft: state => invoke('project:draft', state),
  removeAttachment: input => invoke('project:remove-attachment', input),
  openProject: () => invoke('project:open'),
  newProject: info => invoke('project:new', info),
  activateProject: id => invoke('project:activate', id),
  revealProject: () => invoke('project:reveal'),
  saveProject: (project, saveAs) => invoke('project:save', project, saveAs),
  compile: (project, id) => invoke('pdf:compile', project, id),
  publishBuild: id => invoke('pdf:publish', id),
  exportPDF: (id, title) => invoke('pdf:export', id, title),
  openPDF: id => invoke('pdf:external', id),
  exportSource: (format, project, id) => invoke('source:export', format, project, id),
  searchZotero: (query, groupID, start, sort, collectionKey) => invoke('zotero:search', query, groupID, start, sort, collectionKey),
  zoteroCollections: groupID => invoke('zotero:collections', groupID),
  zoteroGroups: () => invoke('zotero:groups'),
  zoteroSelection: () => invoke('zotero:selection'),
  citeZotero: (item, refs) => invoke('zotero:export', item, refs),
  onFlush: listener => { ipcRenderer.on('close:flush', () => listener()); },
  close: approved => invoke('close:respond', approved)
});
