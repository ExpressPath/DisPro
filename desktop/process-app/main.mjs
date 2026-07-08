import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCredentialStore } from "./main/credentialStore.mjs";
import { ProcessController } from "./main/processController.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const credentials = createCredentialStore("Dispro Process");
let mainWindow;
let controller;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 640,
    title: "Dispro Process",
    backgroundColor: "#fbfbf8",
    webPreferences: {
      preload: join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  controller = new ProcessController({
    credentials,
    onStatus: (status) => mainWindow?.webContents.send("process:status", status)
  });

  mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  await controller?.stop();
});

ipcMain.handle("auth:load", async () => {
  return controller.loadStoredAuth();
});

ipcMain.handle("auth:request-link", async (_event, input) => {
  return controller.requestSignInLink(input);
});

ipcMain.handle("auth:verify", async (_event, input) => {
  return controller.verifySignIn(input);
});

ipcMain.handle("auth:clear", async () => {
  return controller.clearStoredAuth();
});

ipcMain.handle("process:start", async () => {
  return controller.start();
});

ipcMain.handle("process:stop", async () => {
  return controller.stop();
});

ipcMain.handle("process:status", async () => {
  return controller.getStatus();
});

ipcMain.handle("billing:status", async (_event, setupSessionId) => {
  return controller.getBillingStatus(setupSessionId);
});

ipcMain.handle("billing:setup", async () => {
  return controller.startBillingSetup();
});

ipcMain.handle("use:create-order", async (_event, input) => {
  return controller.createUseOrder(input);
});

ipcMain.handle("use:get-order", async (_event, orderId) => {
  return controller.getUseOrder(orderId);
});

ipcMain.handle("use:get-result", async (_event, orderId) => {
  return controller.getUseOrderResult(orderId);
});
