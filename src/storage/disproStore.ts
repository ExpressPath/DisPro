import type {
  EmailSignInChallenge,
  NodeProfile,
  PlannedOrder,
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
