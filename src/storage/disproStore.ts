import type {
  DistributedRecord,
  EmailSignInChallenge,
  NodeProfile,
  PlannedOrder,
  ProcessJob,
  ProcessJobResult,
  ProcessNodeRecord,
  UserTransaction,
  UserAccount,
  UserApiKey,
  UserSession
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
  saveProcessJobResult(result: ProcessJobResult): Promise<void>;
  listProcessJobResultsForUser(userId: string): Promise<ProcessJobResult[]>;
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
