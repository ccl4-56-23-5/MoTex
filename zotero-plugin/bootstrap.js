const selectionPath = "/moye-latex/v1/selection";
let bridgeVersion;

class SelectionEndpoint {
  supportedMethods = ["GET"];

  init({ headers }) {
    if (headers.origin !== undefined || headers["x-moyelatex-bridge"] !== "1") {
      return 403;
    }

    const selection = Zotero.getActiveZoteroPane()?.getSelectedItems() ?? [];
    const items = [];
    for (const item of selection) {
      if (!item.isRegularItem() || item.deleted) {
        continue;
      }
      if (item.libraryID === Zotero.Libraries.userLibraryID) {
        items.push({ key: item.key, groupID: null });
        continue;
      }
      const group = Zotero.Groups.getByLibraryID(item.libraryID);
      if (group) {
        items.push({ key: item.key, groupID: group.id });
      }
    }

    return [200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    }, JSON.stringify({ protocol: 1, version: bridgeVersion, items })];
  }
}

function startup({ version }) {
  bridgeVersion = version;
  Zotero.Server.Endpoints[selectionPath] = SelectionEndpoint;
}

function shutdown() {
  if (Zotero.Server.Endpoints[selectionPath] === SelectionEndpoint) {
    delete Zotero.Server.Endpoints[selectionPath];
  }
}
