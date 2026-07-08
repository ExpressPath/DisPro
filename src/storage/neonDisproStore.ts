import { neon } from "@neondatabase/serverless";
import type {
  BillingCustomer,
  DistributedRecord,
  EmailSignInChallenge,
  NodeProfile,
  PlannedOrder,
  ProcessJob,
  ProcessJobResult,
  ProcessNodeRecord,
  UseOrderRecord,
  UserAccount,
  UserApiKey,
  UserSession,
  UserTransaction
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
  processJobResults: ProcessJobResult[];
  useOrders: UseOrderRecord[];
  billingCustomers: BillingCustomer[];
  distributedRecords: DistributedRecord[];
  userTransactions: UserTransaction[];
}

export class NeonDisproStore implements DisproStore {
  private state: PersistedState | undefined;
  private readonly sql: ReturnType<typeof neon>;
  private readonly stateKey: string;

  private constructor(databaseUrl: string, stateKey: string) {
    this.sql = neon(databaseUrl);
    this.stateKey = stateKey;
  }

  static async open(databaseUrl: string, seedNodes: readonly NodeProfile[] = []): Promise<NeonDisproStore> {
    const store = new NeonDisproStore(databaseUrl, process.env.DISPRO_NEON_STATE_KEY ?? "default");
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
    upsertBy(this.requireState().orders, plan, (candidate) => candidate.order.id === plan.order.id);
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
    upsertBy(this.requireState().nodes, node, (candidate) => candidate.id === node.id);
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
    upsertBy(this.requireState().users, user, (candidate) => candidate.id === user.id);
    await this.persist();
  }

  async saveEmailChallenge(challenge: EmailSignInChallenge): Promise<void> {
    await this.ensureLoaded();
    upsertBy(this.requireState().emailChallenges, challenge, (candidate) => candidate.id === challenge.id);
    await this.persist();
  }

  async getEmailChallengeByTokenHash(tokenHash: string): Promise<EmailSignInChallenge | undefined> {
    await this.ensureLoaded();
    const challenge = this.requireState().emailChallenges.find((candidate) => candidate.tokenHash === tokenHash);
    return challenge ? clone(challenge) : undefined;
  }

  async markEmailChallengeConsumed(challengeId: string, consumedAt: string): Promise<void> {
    await this.ensureLoaded();
    const challenge = this.requireState().emailChallenges.find((candidate) => candidate.id === challengeId);
    if (challenge) {
      challenge.consumedAt = consumedAt;
      await this.persist();
    }
  }

  async saveSession(session: UserSession): Promise<void> {
    await this.ensureLoaded();
    upsertBy(this.requireState().sessions, session, (candidate) => candidate.id === session.id);
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
    upsertBy(this.requireState().apiKeys, apiKey, (candidate) => candidate.id === apiKey.id);
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
    upsertBy(this.requireState().processNodes, node, (candidate) => candidate.id === node.id);
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
    upsertBy(this.requireState().processJobs, job, (candidate) => candidate.id === job.id);
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

  async saveProcessJobResult(result: ProcessJobResult): Promise<void> {
    await this.ensureLoaded();
    upsertBy(this.requireState().processJobResults, result, (candidate) => candidate.id === result.id);
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
    upsertBy(this.requireState().useOrders, order, (candidate) => candidate.id === order.id);
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
    upsertBy(this.requireState().billingCustomers, customer, (candidate) => candidate.userId === customer.userId);
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
    upsertBy(this.requireState().distributedRecords, record, (candidate) => candidate.id === record.id);
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
    upsertBy(this.requireState().userTransactions, transaction, (candidate) => candidate.id === transaction.id);
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
    await this.sql`
      CREATE TABLE IF NOT EXISTS dispro_state (
        id TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const rows = (await this.sql`
      SELECT state FROM dispro_state WHERE id = ${this.stateKey} LIMIT 1
    `) as Array<{ state: unknown }>;

    if (rows.length === 0) {
      this.state = createEmptyState(seedNodes);
      await this.persist();
      return;
    }

    this.state = normalizeState(rows[0]?.state);
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
      throw new Error("NeonDisproStore has not been loaded.");
    }

    return this.state;
  }

  private async persist(): Promise<void> {
    const state = this.requireState();
    state.updatedAt = new Date().toISOString();
    await this.sql`
      INSERT INTO dispro_state (id, state, updated_at)
      VALUES (${this.stateKey}, ${JSON.stringify(state)}::jsonb, now())
      ON CONFLICT (id)
      DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
    `;
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
    processJobResults: [],
    useOrders: [],
    billingCustomers: [],
    distributedRecords: [],
    userTransactions: []
  };
}

function normalizeState(value: unknown): PersistedState {
  if (!isRecord(value)) {
    return createEmptyState([]);
  }

  return {
    version: 1,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    orders: Array.isArray(value.orders) ? (value.orders as PlannedOrder[]) : [],
    nodes: Array.isArray(value.nodes) ? (value.nodes as NodeProfile[]) : [],
    users: Array.isArray(value.users) ? (value.users as UserAccount[]) : [],
    emailChallenges: Array.isArray(value.emailChallenges)
      ? (value.emailChallenges as EmailSignInChallenge[])
      : [],
    sessions: Array.isArray(value.sessions) ? (value.sessions as UserSession[]) : [],
    apiKeys: Array.isArray(value.apiKeys)
      ? (value.apiKeys as UserApiKey[]).map((apiKey) => ({
          ...apiKey,
          purpose: apiKey.purpose ?? "general"
        }))
      : [],
    processNodes: Array.isArray(value.processNodes) ? (value.processNodes as ProcessNodeRecord[]) : [],
    processJobs: Array.isArray(value.processJobs) ? (value.processJobs as ProcessJob[]) : [],
    processJobResults: Array.isArray(value.processJobResults)
      ? (value.processJobResults as ProcessJobResult[])
      : [],
    useOrders: Array.isArray(value.useOrders) ? (value.useOrders as UseOrderRecord[]) : [],
    billingCustomers: Array.isArray(value.billingCustomers)
      ? (value.billingCustomers as BillingCustomer[])
      : [],
    distributedRecords: Array.isArray(value.distributedRecords)
      ? (value.distributedRecords as DistributedRecord[])
      : [],
    userTransactions: Array.isArray(value.userTransactions)
      ? (value.userTransactions as UserTransaction[])
      : []
  };
}

function upsertBy<T>(items: T[], value: T, predicate: (candidate: T) => boolean): void {
  const index = items.findIndex(predicate);
  if (index >= 0) {
    items[index] = clone(value);
    return;
  }

  items.push(clone(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
