import { createHash, sign } from "node:crypto";
import { stableStringify } from "../domain/ids.js";
import {
  getAndroidProcessDownload,
  getChromeProcessDownload,
  getLinuxProcessDownload,
  getWindowsProcessDownload,
  type DownloadManifestItem
} from "./downloadService.js";

const DEV_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKZ4/Q3gtCK2Qx2Zcvv8iU9hsEwI4gb5IuKGojPYKzfc
-----END PRIVATE KEY-----`;

const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbTYmuTvvI6+vd7NsDhpMOgbnGvaQoqxFUE8cgIqk7ds=
-----END PUBLIC KEY-----`;

export interface UpdateAssetRecord {
  platform: DownloadManifestItem["platform"];
  architecture: DownloadManifestItem["architecture"];
  fileName: string;
  version: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  updateProvider: DownloadManifestItem["updateProvider"];
}

export interface UpdateCommitRecord {
  id: string;
  parent: string | null;
  tree: string;
  subject: string;
  createdAt: string;
  assets: UpdateAssetRecord[];
  signature: string;
}

export interface ProcessUpdateGraph {
  kind: "dispro.process.update-graph";
  schemaVersion: 1;
  refs: Record<string, string>;
  commits: Record<string, UpdateCommitRecord>;
  publicKey: string;
  etag: string;
}

export async function getProcessUpdateGraph(now = new Date()): Promise<ProcessUpdateGraph> {
  const downloads = await Promise.all([
    getWindowsProcessDownload(),
    getLinuxProcessDownload(),
    getChromeProcessDownload(),
    getAndroidProcessDownload()
  ]);
  const createdAt = process.env.DISPRO_UPDATE_GRAPH_CREATED_AT ?? now.toISOString();
  const parent = normalizeParent(process.env.DISPRO_UPDATE_PARENT_COMMIT);
  const refs: Record<string, string> = {};
  const commits: Record<string, UpdateCommitRecord> = {};

  for (const download of downloads) {
    const commit = createUpdateCommit(download, parent, createdAt);
    const ref = `refs/process/${download.platform}/stable`;
    refs[ref] = commit.id;
    commits[commit.id] = commit;
  }

  const unsignedGraph = {
    kind: "dispro.process.update-graph",
    schemaVersion: 1,
    refs,
    commits,
    publicKey: publicKey()
  } as const;
  const etag = `"${sha256(stableStringify(unsignedGraph))}"`;

  return {
    ...unsignedGraph,
    etag
  };
}

export async function getProcessUpdateRef(platform: string, now = new Date()): Promise<{
  ref: string;
  commit: UpdateCommitRecord;
  publicKey: string;
  etag: string;
}> {
  const graph = await getProcessUpdateGraph(now);
  const ref = `refs/process/${platform}/stable`;
  const commitId = graph.refs[ref];
  const commit = commitId ? graph.commits[commitId] : undefined;
  if (!commit) {
    throw new Error(`Process update ref not found: ${ref}`);
  }
  return {
    ref,
    commit,
    publicKey: graph.publicKey,
    etag: `"${sha256(stableStringify({ ref, commit, publicKey: graph.publicKey }))}"`
  };
}

export function createUpdateCommit(
  download: DownloadManifestItem,
  parent: string | null,
  createdAt: string
): UpdateCommitRecord {
  const asset: UpdateAssetRecord = {
    platform: download.platform,
    architecture: download.architecture,
    fileName: download.fileName,
    version: download.version,
    sizeBytes: download.sizeBytes,
    sha256: download.sha256,
    downloadUrl: download.downloadUrl,
    updateProvider: download.updateProvider
  };
  const unsigned = {
    parent,
    tree: sha256(stableStringify([asset])),
    subject: `Dispro Process ${download.platform} ${download.version}`,
    createdAt,
    assets: [asset]
  };
  const id = sha256(stableStringify(unsigned));
  const signature = sign(null, Buffer.from(stableStringify({ id, ...unsigned })), privateKey()).toString("base64url");
  return {
    id,
    ...unsigned,
    signature
  };
}

function normalizeParent(value: string | undefined): string | null {
  return value && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function publicKey(): string {
  return process.env.DISPRO_UPDATE_SIGNING_PUBLIC_KEY ?? process.env.DISPRO_JOB_SIGNING_PUBLIC_KEY ?? DEFAULT_PUBLIC_KEY;
}

function privateKey(): string {
  return process.env.DISPRO_UPDATE_SIGNING_PRIVATE_KEY ?? process.env.DISPRO_JOB_SIGNING_PRIVATE_KEY ?? DEV_PRIVATE_KEY;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
