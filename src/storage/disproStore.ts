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

export interface OrderSummary {
  id: string;
  customerId: string;
  workload: string;
  submittedAt: string;
  priority: string;
  verificationLevel: string;
  totalMicroYen: number;
  taskCount: number;
  assignmentCount: number;
  unassignedTaskCount: number;
}

export interface DisproStore {
  listPlannedOrders(): Promise<PlannedOrder[]>;
  listOrderSummaries(): Promise<OrderSummary[]>;
  getPlannedOrder(orderId: string): Promise<PlannedOrder | undefined>;
  savePlannedOrder(plan: PlannedOrder): Promise<void>;
  listNodes(): Promise<NodeProfile[]>;
  getNode(nodeId: string): Promise<NodeProfile | undefined>;
  upsertNode(node: NodeProfile): Promise<void>;
  listUsers(): Promise<UserAccount[]>;
  getUser(userId: string): Promise<UserAccount | undefined>;
  getUserByEmail(email: string): Promise<UserAccount | undefined>;
  upsertUser(user: UserAccount): Promise<void>;
  saveEmailChallenge(challenge: EmailSignInChallenge): Promise<void>;
  getEmailChallengeByTokenHash(tokenHash: string): Promise<EmailSignInChallenge | undefined>;
  markEmailChallengeConsumed(challengeId: string, consumedAt: string): Promise<void>;
  saveSession(session: UserSession): Promise<void>;
  getSessionByTokenHash(tokenHash: string): Promise<UserSession | undefined>;
  touchSession(sessionId: string, usedAt: string): Promise<void>;
  saveApiKey(apiKey: UserApiKey): Promise<void>;
  listApiKeysForUser(userId: string): Promise<UserApiKey[]>;
  getApiKeyByHash(keyHash: string): Promise<UserApiKey | undefined>;
  touchApiKey(apiKeyId: string, usedAt: string): Promise<void>;
  upsertProcessNode(node: ProcessNodeRecord): Promise<void>;
  getProcessNode(nodeId: string): Promise<ProcessNodeRecord | undefined>;
  getProcessNodeByMachine(userId: string, machineId: string): Promise<ProcessNodeRecord | undefined>;
  listProcessNodesForUser(userId: string): Promise<ProcessNodeRecord[]>;
  saveProcessJob(job: ProcessJob): Promise<void>;
  getProcessJob(jobId: string): Promise<ProcessJob | undefined>;
  listProcessJobs(): Promise<ProcessJob[]>;
  saveWorkUnit(workUnit: WorkUnit): Promise<void>;
  getWorkUnit(workUnitId: string): Promise<WorkUnit | undefined>;
  listWorkUnits(): Promise<WorkUnit[]>;
  saveConsensusRecord(record: ConsensusRecord): Promise<void>;
  getConsensusRecord(workUnitId: string): Promise<ConsensusRecord | undefined>;
  listConsensusRecords(): Promise<ConsensusRecord[]>;
  saveNodeCapabilitySnapshot(snapshot: NodeCapabilitySnapshot): Promise<void>;
  listNodeCapabilitySnapshots(processNodeId?: string): Promise<NodeCapabilitySnapshot[]>;
  saveProcessJobResult(result: ProcessJobResult): Promise<void>;
  listProcessJobResults(): Promise<ProcessJobResult[]>;
  listProcessJobResultsForUser(userId: string): Promise<ProcessJobResult[]>;
  saveUseOrder(order: UseOrderRecord): Promise<void>;
  getUseOrder(orderId: string): Promise<UseOrderRecord | undefined>;
  listUseOrdersForUser(userId: string): Promise<UseOrderRecord[]>;
  saveBillingCustomer(customer: BillingCustomer): Promise<void>;
  getBillingCustomerByUserId(userId: string): Promise<BillingCustomer | undefined>;
  getBillingCustomerByStripeCustomerId(stripeCustomerId: string): Promise<BillingCustomer | undefined>;
  saveDistributedRecord(record: DistributedRecord): Promise<void>;
  listDistributedRecordsForUser(userId: string): Promise<DistributedRecord[]>;
  getDistributedRecord(recordId: string): Promise<DistributedRecord | undefined>;
  saveUserTransaction(transaction: UserTransaction): Promise<void>;
  listUserTransactions(userId: string): Promise<UserTransaction[]>;
  getUserTransaction(transactionId: string): Promise<UserTransaction | undefined>;
}

export function summarizeOrder(plan: PlannedOrder): OrderSummary {
  return {
    id: plan.order.id,
    customerId: plan.order.customerId,
    workload: plan.order.workload,
    submittedAt: plan.order.submittedAt,
    priority: plan.order.priority,
    verificationLevel: plan.order.verificationLevel,
    totalMicroYen: plan.quote.totalMicroYen,
    taskCount: plan.tasks.length,
    assignmentCount: plan.assignments.length,
    unassignedTaskCount: plan.unassignedTasks.length
  };
}
