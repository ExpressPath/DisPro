import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  BillingCustomer,
  ConsensusRecord,
  DistributedRecord,
  EmailSignInChallenge,
  NodeCapabilitySnapshot,
  NodeProfile,
  PlannedOrder,
  ProcessJob,
  ProcessJobResult,
  ProcessNodeRecord,
  UseOrderRecord,
  UserTransaction,
  UserAccount,
  UserApiKey,
  UserSession,
  WorkUnit
} from "../domain/types.js";
import type { DisproStore, OrderSummary } from "./disproStore.js";
import { summarizeOrder } from "./disproStore.js";

interface PersistedState {
  version: 1;
  updatedAt: string;
  orders: PlannedOrder[];
  nodes: NodeProfile[];
  users: UserAccount[];
  emailChallenges: EmailSignInChallenge[];
  sessions: UserSession[];
  apiKeys: UserApiKey[];
  processNodes: ProcessNodeRecord[];
  processJobs: ProcessJob[];
  workUnits: WorkUnit[];
  consensusRecords: ConsensusRecord[];
  nodeCapabilitySnapshots: NodeCapabilitySnapshot[];
  processJobResults: ProcessJobResult[];
  useOrders: UseOrderRecord[];
  billingCustomers: BillingCustomer[];
  distributedRecords: DistributedRecord[];
  userTransactions: UserTransaction[];
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

  async listUsers(): Promise<UserAccount[]> {
    await this.ensureLoaded();
    return clone(this.requireState().users);
  }

  async getUser(userId: string): Promise<UserAccount | undefined> {
    await this.ensureLoaded();
    const user = this.requireState().users.find((candidate) => candidate.id === userId);
    return user ? clone(user) : undefined;
  }

  async getUserByEmail(email: string): Promise<UserAccount | undefined> {
    await this.ensureLoaded();
    const user = this.requireState().users.find((candidate) => candidate.email === email);
    return user ? clone(user) : undefined;
  }

  async upsertUser(user: UserAccount): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.users.findIndex((candidate) => candidate.id === user.id);

    if (index >= 0) {
      state.users[index] = clone(user);
    } else {
      state.users.push(clone(user));
    }

    await this.persist();
  }

  async saveEmailChallenge(challenge: EmailSignInChallenge): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.emailChallenges.findIndex((candidate) => candidate.id === challenge.id);

    if (index >= 0) {
      state.emailChallenges[index] = clone(challenge);
    } else {
      state.emailChallenges.push(clone(challenge));
    }

    await this.persist();
  }

  async getEmailChallengeByTokenHash(tokenHash: string): Promise<EmailSignInChallenge | undefined> {
    await this.ensureLoaded();
    const challenge = this.requireState().emailChallenges.find((candidate) => candidate.tokenHash === tokenHash);
    return challenge ? clone(challenge) : undefined;
  }

  async markEmailChallengeConsumed(challengeId: string, consumedAt: string): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const challenge = state.emailChallenges.find((candidate) => candidate.id === challengeId);
    if (challenge) {
      challenge.consumedAt = consumedAt;
      await this.persist();
    }
  }

  async saveSession(session: UserSession): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.sessions.findIndex((candidate) => candidate.id === session.id);

    if (index >= 0) {
      state.sessions[index] = clone(session);
    } else {
      state.sessions.push(clone(session));
    }

    await this.persist();
  }

  async getSessionByTokenHash(tokenHash: string): Promise<UserSession | undefined> {
    await this.ensureLoaded();
    const session = this.requireState().sessions.find((candidate) => candidate.tokenHash === tokenHash);
    return session ? clone(session) : undefined;
  }

  async touchSession(sessionId: string, usedAt: string): Promise<void> {
    await this.ensureLoaded();
    const session = this.requireState().sessions.find((candidate) => candidate.id === sessionId);
    if (session) {
      session.lastUsedAt = usedAt;
      await this.persist();
    }
  }

  async saveApiKey(apiKey: UserApiKey): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.apiKeys.findIndex((candidate) => candidate.id === apiKey.id);

    if (index >= 0) {
      state.apiKeys[index] = clone(apiKey);
    } else {
      state.apiKeys.push(clone(apiKey));
    }

    await this.persist();
  }

  async listApiKeysForUser(userId: string): Promise<UserApiKey[]> {
    await this.ensureLoaded();
    return clone(this.requireState().apiKeys.filter((candidate) => candidate.userId === userId));
  }

  async getApiKeyByHash(keyHash: string): Promise<UserApiKey | undefined> {
    await this.ensureLoaded();
    const apiKey = this.requireState().apiKeys.find((candidate) => candidate.keyHash === keyHash);
    return apiKey ? clone(apiKey) : undefined;
  }

  async touchApiKey(apiKeyId: string, usedAt: string): Promise<void> {
    await this.ensureLoaded();
    const apiKey = this.requireState().apiKeys.find((candidate) => candidate.id === apiKeyId);
    if (apiKey) {
      apiKey.lastUsedAt = usedAt;
      await this.persist();
    }
  }

  async upsertProcessNode(node: ProcessNodeRecord): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.processNodes.findIndex((candidate) => candidate.id === node.id);

    if (index >= 0) {
      state.processNodes[index] = clone(node);
    } else {
      state.processNodes.push(clone(node));
    }

    await this.persist();
  }

  async getProcessNode(nodeId: string): Promise<ProcessNodeRecord | undefined> {
    await this.ensureLoaded();
    const node = this.requireState().processNodes.find((candidate) => candidate.id === nodeId);
    return node ? clone(node) : undefined;
  }

  async getProcessNodeByMachine(userId: string, machineId: string): Promise<ProcessNodeRecord | undefined> {
    await this.ensureLoaded();
    const node = this.requireState().processNodes.find(
      (candidate) => candidate.userId === userId && candidate.machineId === machineId
    );
    return node ? clone(node) : undefined;
  }

  async listProcessNodesForUser(userId: string): Promise<ProcessNodeRecord[]> {
    await this.ensureLoaded();
    return clone(this.requireState().processNodes.filter((candidate) => candidate.userId === userId));
  }

  async saveProcessJob(job: ProcessJob): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.processJobs.findIndex((candidate) => candidate.id === job.id);

    if (index >= 0) {
      state.processJobs[index] = clone(job);
    } else {
      state.processJobs.push(clone(job));
    }

    await this.persist();
  }

  async getProcessJob(jobId: string): Promise<ProcessJob | undefined> {
    await this.ensureLoaded();
    const job = this.requireState().processJobs.find((candidate) => candidate.id === jobId);
    return job ? clone(job) : undefined;
  }

  async listProcessJobs(): Promise<ProcessJob[]> {
    await this.ensureLoaded();
    return clone(this.requireState().processJobs);
  }

  async saveWorkUnit(workUnit: WorkUnit): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.workUnits.findIndex((candidate) => candidate.id === workUnit.id);

    if (index >= 0) {
      state.workUnits[index] = clone(workUnit);
    } else {
      state.workUnits.push(clone(workUnit));
    }

    await this.persist();
  }

  async getWorkUnit(workUnitId: string): Promise<WorkUnit | undefined> {
    await this.ensureLoaded();
    const workUnit = this.requireState().workUnits.find((candidate) => candidate.id === workUnitId);
    return workUnit ? clone(workUnit) : undefined;
  }

  async listWorkUnits(): Promise<WorkUnit[]> {
    await this.ensureLoaded();
    return clone(this.requireState().workUnits);
  }

  async saveConsensusRecord(record: ConsensusRecord): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.consensusRecords.findIndex((candidate) => candidate.id === record.id);

    if (index >= 0) {
      state.consensusRecords[index] = clone(record);
    } else {
      state.consensusRecords.push(clone(record));
    }

    await this.persist();
  }

  async getConsensusRecord(workUnitId: string): Promise<ConsensusRecord | undefined> {
    await this.ensureLoaded();
    const records = this.requireState().consensusRecords
      .filter((candidate) => candidate.workUnitId === workUnitId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return records[0] ? clone(records[0]) : undefined;
  }

  async listConsensusRecords(): Promise<ConsensusRecord[]> {
    await this.ensureLoaded();
    return clone(this.requireState().consensusRecords);
  }

  async saveNodeCapabilitySnapshot(snapshot: NodeCapabilitySnapshot): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.nodeCapabilitySnapshots.findIndex((candidate) => candidate.id === snapshot.id);

    if (index >= 0) {
      state.nodeCapabilitySnapshots[index] = clone(snapshot);
    } else {
      state.nodeCapabilitySnapshots.push(clone(snapshot));
    }

    await this.persist();
  }

  async listNodeCapabilitySnapshots(processNodeId?: string): Promise<NodeCapabilitySnapshot[]> {
    await this.ensureLoaded();
    const snapshots = this.requireState().nodeCapabilitySnapshots;
    return clone(
      processNodeId === undefined
        ? snapshots
        : snapshots.filter((candidate) => candidate.processNodeId === processNodeId)
    );
  }

  async saveProcessJobResult(result: ProcessJobResult): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.processJobResults.findIndex((candidate) => candidate.id === result.id);

    if (index >= 0) {
      state.processJobResults[index] = clone(result);
    } else {
      state.processJobResults.push(clone(result));
    }

    await this.persist();
  }

  async listProcessJobResults(): Promise<ProcessJobResult[]> {
    await this.ensureLoaded();
    return clone(this.requireState().processJobResults);
  }

  async listProcessJobResultsForUser(userId: string): Promise<ProcessJobResult[]> {
    await this.ensureLoaded();
    return clone(this.requireState().processJobResults.filter((candidate) => candidate.userId === userId));
  }

  async saveUseOrder(order: UseOrderRecord): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.useOrders.findIndex((candidate) => candidate.id === order.id);

    if (index >= 0) {
      state.useOrders[index] = clone(order);
    } else {
      state.useOrders.push(clone(order));
    }

    await this.persist();
  }

  async getUseOrder(orderId: string): Promise<UseOrderRecord | undefined> {
    await this.ensureLoaded();
    const order = this.requireState().useOrders.find((candidate) => candidate.id === orderId);
    return order ? clone(order) : undefined;
  }

  async listUseOrdersForUser(userId: string): Promise<UseOrderRecord[]> {
    await this.ensureLoaded();
    return clone(this.requireState().useOrders.filter((candidate) => candidate.userId === userId));
  }

  async saveBillingCustomer(customer: BillingCustomer): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.billingCustomers.findIndex((candidate) => candidate.userId === customer.userId);

    if (index >= 0) {
      state.billingCustomers[index] = clone(customer);
    } else {
      state.billingCustomers.push(clone(customer));
    }

    await this.persist();
  }

  async getBillingCustomerByUserId(userId: string): Promise<BillingCustomer | undefined> {
    await this.ensureLoaded();
    const customer = this.requireState().billingCustomers.find((candidate) => candidate.userId === userId);
    return customer ? clone(customer) : undefined;
  }

  async getBillingCustomerByStripeCustomerId(stripeCustomerId: string): Promise<BillingCustomer | undefined> {
    await this.ensureLoaded();
    const customer = this.requireState().billingCustomers.find(
      (candidate) => candidate.stripeCustomerId === stripeCustomerId
    );
    return customer ? clone(customer) : undefined;
  }

  async saveDistributedRecord(record: DistributedRecord): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.distributedRecords.findIndex((candidate) => candidate.id === record.id);

    if (index >= 0) {
      state.distributedRecords[index] = clone(record);
    } else {
      state.distributedRecords.push(clone(record));
    }

    await this.persist();
  }

  async listDistributedRecordsForUser(userId: string): Promise<DistributedRecord[]> {
    await this.ensureLoaded();
    return clone(this.requireState().distributedRecords.filter((candidate) => candidate.userId === userId));
  }

  async getDistributedRecord(recordId: string): Promise<DistributedRecord | undefined> {
    await this.ensureLoaded();
    const record = this.requireState().distributedRecords.find((candidate) => candidate.id === recordId);
    return record ? clone(record) : undefined;
  }

  async saveUserTransaction(transaction: UserTransaction): Promise<void> {
    await this.ensureLoaded();
    const state = this.requireState();
    const index = state.userTransactions.findIndex((candidate) => candidate.id === transaction.id);

    if (index >= 0) {
      state.userTransactions[index] = clone(transaction);
    } else {
      state.userTransactions.push(clone(transaction));
    }

    await this.persist();
  }

  async listUserTransactions(userId: string): Promise<UserTransaction[]> {
    await this.ensureLoaded();
    return clone(this.requireState().userTransactions.filter((candidate) => candidate.userId === userId));
  }

  async getUserTransaction(transactionId: string): Promise<UserTransaction | undefined> {
    await this.ensureLoaded();
    const transaction = this.requireState().userTransactions.find((candidate) => candidate.id === transactionId);
    return transaction ? clone(transaction) : undefined;
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
    nodes: clone([...seedNodes]),
    users: [],
    emailChallenges: [],
    sessions: [],
    apiKeys: [],
    processNodes: [],
    processJobs: [],
    workUnits: [],
    consensusRecords: [],
    nodeCapabilitySnapshots: [],
    processJobResults: [],
    useOrders: [],
    billingCustomers: [],
    distributedRecords: [],
    userTransactions: []
  };
}

function normalizeState(value: unknown): PersistedState {
  if (!isRecord(value)) {
    throw new Error("Persisted Dispro state must be an object.");
  }

  const orders = Array.isArray(value.orders) ? (value.orders as PlannedOrder[]) : [];
  const nodes = Array.isArray(value.nodes) ? (value.nodes as NodeProfile[]) : [];
  const users = Array.isArray(value.users) ? (value.users as UserAccount[]) : [];
  const emailChallenges = Array.isArray(value.emailChallenges)
    ? (value.emailChallenges as EmailSignInChallenge[])
    : [];
  const sessions = Array.isArray(value.sessions) ? (value.sessions as UserSession[]) : [];
  const apiKeys = Array.isArray(value.apiKeys)
    ? (value.apiKeys as UserApiKey[]).map((apiKey) => ({
        ...apiKey,
        purpose: apiKey.purpose ?? "general"
      }))
    : [];
  const processNodes = Array.isArray(value.processNodes) ? (value.processNodes as ProcessNodeRecord[]) : [];
  const processJobs = Array.isArray(value.processJobs) ? (value.processJobs as ProcessJob[]) : [];
  const workUnits = Array.isArray(value.workUnits) ? (value.workUnits as WorkUnit[]) : [];
  const consensusRecords = Array.isArray(value.consensusRecords)
    ? (value.consensusRecords as ConsensusRecord[])
    : [];
  const nodeCapabilitySnapshots = Array.isArray(value.nodeCapabilitySnapshots)
    ? (value.nodeCapabilitySnapshots as NodeCapabilitySnapshot[])
    : [];
  const processJobResults = Array.isArray(value.processJobResults)
    ? (value.processJobResults as ProcessJobResult[])
    : [];
  const useOrders = Array.isArray(value.useOrders) ? (value.useOrders as UseOrderRecord[]) : [];
  const billingCustomers = Array.isArray(value.billingCustomers)
    ? (value.billingCustomers as BillingCustomer[])
    : [];
  const distributedRecords = Array.isArray(value.distributedRecords)
    ? (value.distributedRecords as DistributedRecord[])
    : [];
  const userTransactions = Array.isArray(value.userTransactions)
    ? (value.userTransactions as UserTransaction[])
    : [];
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString();

  return {
    version: 1,
    updatedAt,
    orders,
    nodes,
    users,
    emailChallenges,
    sessions,
    apiKeys,
    processNodes,
    processJobs,
    workUnits,
    consensusRecords,
    nodeCapabilitySnapshots,
    processJobResults,
    useOrders,
    billingCustomers,
    distributedRecords,
    userTransactions
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
