import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dispro", {
  auth: {
    load: () => ipcRenderer.invoke("auth:load"),
    requestLink: (input) => ipcRenderer.invoke("auth:request-link", input),
    verify: (input) => ipcRenderer.invoke("auth:verify", input),
    clear: () => ipcRenderer.invoke("auth:clear")
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
  },
  billing: {
    status: (setupSessionId) => ipcRenderer.invoke("billing:status", setupSessionId),
    setup: () => ipcRenderer.invoke("billing:setup")
  },
  use: {
    createOrder: (input) => ipcRenderer.invoke("use:create-order", input),
    getOrder: (orderId) => ipcRenderer.invoke("use:get-order", orderId),
    getResult: (orderId) => ipcRenderer.invoke("use:get-result", orderId)
  }
});
