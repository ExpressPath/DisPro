import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dispro", {
  auth: {
    load: () => ipcRenderer.invoke("auth:load"),
    requestLink: (input) => ipcRenderer.invoke("auth:request-link", input),
    verify: (input) => ipcRenderer.invoke("auth:verify", input)
  },
  process: {
    start: () => ipcRenderer.invoke("process:start"),
    stop: () => ipcRenderer.invoke("process:stop"),
    status: () => ipcRenderer.invoke("process:status"),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("process:status", listener);
      return () => ipcRenderer.removeListener("process:status", listener);
    }
  }
});
