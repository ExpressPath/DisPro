import type { NodeProfile, PlannedOrder } from "../domain/types.js";

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
