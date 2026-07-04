import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NodeProfile, PlannedOrder } from "../domain/types.js";
import type { DisproStore, OrderSummary } from "./disproStore.js";
import { summarizeOrder } from "./disproStore.js";

interface PersistedState {
  version: 1;
  updatedAt: string;
  orders: PlannedOrder[];
  nodes: NodeProfile[];
}

export class FileDisproStore implements DisproStore {
  private state: PersistedState | undefined;

  constructor(private readonly filePath: string) {}

  static async open(filePath: string, seedNodes: readonly NodeProfile[] = []): Promise<FileDisproStore> {
    const store = new FileDisproStore(filePath);
    await store.load(seedNodes);
    return store;
  }

  async listPlannedOrders(): Promise<PlannedOrder[]> {
    await this.ensureLoaded();
    return clone(this.requireState().orders);
  }

  async listOrderSummaries(): Promise<OrderSummary[]> {
    await this.ensureLoaded();
    return this.requireState()
      .orders.map((plan) => summarizeOrder(plan))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }

  async getPlannedOrder(orderId: string): Promise<PlannedOrder | undefined> {
    await this.ensureLoaded();
    const plan = this.requireState().orders.find((order) => order.order.id === orderId);
    return plan ? clone(plan) : undefined;
  }

  async savePlannedOrder(plan: PlannedOrder): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.orders.findIndex((order) => order.order.id === plan.order.id);

    if (index >= 0) {
      state.orders[index] = clone(plan);
    } else {
      state.orders.push(clone(plan));
    }

    await this.persist();
  }

  async listNodes(): Promise<NodeProfile[]> {
    await this.ensureLoaded();
    return clone(this.requireState().nodes);
  }

  async getNode(nodeId: string): Promise<NodeProfile | undefined> {
    await this.ensureLoaded();
    const node = this.requireState().nodes.find((candidate) => candidate.id === nodeId);
    return node ? clone(node) : undefined;
  }

  async upsertNode(node: NodeProfile): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.nodes.findIndex((candidate) => candidate.id === node.id);

    if (index >= 0) {
      state.nodes[index] = clone(node);
    } else {
      state.nodes.push(clone(node));
    }

    await this.persist();
  }

  private async load(seedNodes: readonly NodeProfile[]): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      this.state = createEmptyState(seedNodes);
      await this.persist();
      return;
    }

    if (this.state.nodes.length === 0 && seedNodes.length > 0) {
      this.state.nodes = clone([...seedNodes]);
      await this.persist();
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.state) {
      await this.load([]);
    }
  }

  private requireState(): PersistedState {
    if (!this.state) {
      throw new Error("FileDisproStore has not been loaded.");
    }

    return this.state;
  }

  private async persist(): Promise<void> {
    const state = this.requireState();
    state.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.filePath), { recursive: true });

    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function createEmptyState(seedNodes: readonly NodeProfile[]): PersistedState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    orders: [],
    nodes: clone([...seedNodes])
  };
}

function normalizeState(value: unknown): PersistedState {
  if (!isRecord(value)) {
    throw new Error("Persisted Dispro state must be an object.");
  }

  const orders = Array.isArray(value.orders) ? (value.orders as PlannedOrder[]) : [];
  const nodes = Array.isArray(value.nodes) ? (value.nodes as NodeProfile[]) : [];
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString();

  return {
    version: 1,
    updatedAt,
    orders,
    nodes
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
