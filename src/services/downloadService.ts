import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface DownloadManifestItem {
  platform: "windows" | "linux" | "chrome" | "android";
  architecture: "x64" | "browser" | "universal-apk";
  app: "process";
  version: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  role: string;
  recommendedDevice: string;
  minimumSpec: string;
  updateProvider: "github-releases" | "chrome-web-store" | "vercel-blob" | "manual";
}

const STABLE_WINDOWS_ASSET = "Dispro-Process-Windows-x64.exe";
const FALLBACK_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";

export async function getDownloadManifest(): Promise<{ downloads: DownloadManifestItem[] }> {
  const [windows, linux, chrome, android] = await Promise.all([
    getWindowsProcessDownload(),
    getLinuxProcessDownload(),
    getChromeProcessDownload(),
    getAndroidProcessDownload()
  ]);
  return {
    downloads: [windows, linux, chrome, android]
  };
}

export async function getWindowsProcessDownload(): Promise<DownloadManifestItem> {
  const version = process.env.DISPRO_PROCESS_DOWNLOAD_VERSION ?? process.env.DISPRO_PROCESS_UPDATE_VERSION ?? "0.1.0";
  const fileName = process.env.DISPRO_WINDOWS_PROCESS_FILE_NAME ?? STABLE_WINDOWS_ASSET;
  const localExePath = join(process.cwd(), "release", `Dispro Process ${version}.exe`);
  const localMetadata = await getLocalFileMetadata(localExePath);
  const downloadUrl =
    process.env.DISPRO_WINDOWS_PROCESS_DOWNLOAD_URL ??
    `https://github.com/ExpressPath/DisPro/releases/latest/download/${encodeURIComponent(fileName)}`;

  return {
    platform: "windows",
    architecture: "x64",
    app: "process",
    version,
    fileName,
    sizeBytes: parseNumber(process.env.DISPRO_WINDOWS_PROCESS_SIZE_BYTES, localMetadata.sizeBytes),
    sha256: process.env.DISPRO_WINDOWS_PROCESS_SHA256 ?? localMetadata.sha256 ?? FALLBACK_SHA256,
    downloadUrl,
    role: "Earn - Process node",
    recommendedDevice: "Laptop, desktop, GPU PC, or server",
    minimumSpec: "Windows 10/11 x64, 4 CPU cores, 6 GB RAM, stable network",
    updateProvider: downloadUrl.includes("github.com") ? "github-releases" : "manual"
  };
}

export async function getLinuxProcessDownload(): Promise<DownloadManifestItem> {
  const version = process.env.DISPRO_LINUX_PROCESS_DOWNLOAD_VERSION ?? process.env.DISPRO_LINUX_PROCESS_UPDATE_VERSION ?? "0.1.7";
  const fileName = process.env.DISPRO_LINUX_PROCESS_FILE_NAME ?? "Dispro-Process-Linux-x64.AppImage";
  const localPath = join(process.cwd(), "release", fileName);
  const localMetadata = await getLocalFileMetadata(localPath);
  const downloadUrl =
    process.env.DISPRO_LINUX_PROCESS_DOWNLOAD_URL ??
    `https://github.com/ExpressPath/DisPro/releases/latest/download/${encodeURIComponent(fileName)}`;

  return {
    platform: "linux",
    architecture: "x64",
    app: "process",
    version,
    fileName,
    sizeBytes: parseNumber(process.env.DISPRO_LINUX_PROCESS_SIZE_BYTES, localMetadata.sizeBytes),
    sha256: process.env.DISPRO_LINUX_PROCESS_SHA256 ?? localMetadata.sha256 ?? FALLBACK_SHA256,
    downloadUrl,
    role: "Earn - Process node",
    recommendedDevice: "Linux laptop, desktop, GPU PC, or server",
    minimumSpec: "Linux x64, glibc-based desktop/server, 4 CPU cores, 6 GB RAM, stable network",
    updateProvider: downloadUrl.includes("github.com") ? "github-releases" : "manual"
  };
}

export async function getChromeProcessDownload(): Promise<DownloadManifestItem> {
  const version = process.env.DISPRO_CHROME_PROCESS_DOWNLOAD_VERSION ?? "0.1.7";
  const fileName = process.env.DISPRO_CHROME_PROCESS_FILE_NAME ?? "Dispro-Process-Chrome.zip";
  const downloadUrl =
    process.env.DISPRO_CHROME_PROCESS_DOWNLOAD_URL ??
    `https://github.com/ExpressPath/DisPro/releases/latest/download/${encodeURIComponent(fileName)}`;

  return {
    platform: "chrome",
    architecture: "browser",
    app: "process",
    version,
    fileName,
    sizeBytes: parseNumber(process.env.DISPRO_CHROME_PROCESS_SIZE_BYTES, 0),
    sha256: process.env.DISPRO_CHROME_PROCESS_SHA256 ?? FALLBACK_SHA256,
    downloadUrl,
    role: "Earn - Process browser node",
    recommendedDevice: "Chrome on laptop or desktop",
    minimumSpec: "Chrome 113+, 4 CPU cores, 6 GB RAM, stable network",
    updateProvider: process.env.DISPRO_CHROME_PROCESS_WEB_STORE_URL ? "chrome-web-store" : "github-releases"
  };
}

export async function getAndroidProcessDownload(): Promise<DownloadManifestItem> {
  const version = process.env.DISPRO_ANDROID_PROCESS_DOWNLOAD_VERSION ?? "0.1.7";
  const fileName = process.env.DISPRO_ANDROID_PROCESS_FILE_NAME ?? "Dispro-Process-Android.apk";
  const downloadUrl =
    process.env.DISPRO_ANDROID_PROCESS_DOWNLOAD_URL ??
    `https://github.com/ExpressPath/DisPro/releases/latest/download/${encodeURIComponent(fileName)}`;

  return {
    platform: "android",
    architecture: "universal-apk",
    app: "process",
    version,
    fileName,
    sizeBytes: parseNumber(process.env.DISPRO_ANDROID_PROCESS_SIZE_BYTES, 0),
    sha256: process.env.DISPRO_ANDROID_PROCESS_SHA256 ?? FALLBACK_SHA256,
    downloadUrl,
    role: "Earn - Process mobile verification node",
    recommendedDevice: "Android phone or tablet on stable power/network",
    minimumSpec: "Android 12+, 4 CPU cores, 4 GB RAM, stable network",
    updateProvider: process.env.DISPRO_ANDROID_PROCESS_PLAY_STORE_URL ? "manual" : "github-releases"
  };
}

async function getLocalFileMetadata(filePath: string): Promise<{ sizeBytes: number; sha256?: string }> {
  try {
    const [metadata, content] = await Promise.all([stat(filePath), readFile(filePath)]);
    return {
      sizeBytes: metadata.size,
      sha256: createHash("sha256").update(content).digest("hex")
    };
  } catch {
    return {
      sizeBytes: 0
    };
  }
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
