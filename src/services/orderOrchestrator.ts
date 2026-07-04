import type { AuditEvent, NodeProfile, OrderRequest, PlannedOrder, TaskAssignment, TaskSpec } from "../domain/types.js";
import { appendAuditEvent } from "../domain/auditLog.js";
import { normalizeOrderRequest } from "../domain/order.js";
import { quoteOrder } from "../domain/pricing.js";
import { assignTasksToNodes } from "../domain/scheduler.js";
import { createVerificationTasks, splitOrderIntoComputeTasks } from "../domain/taskSplitter.js";

export interface PlanOrderOptions {
  now?: Date;
  seed?: string;
}

export function planOrder(
  request: OrderRequest,
  nodes: readonly NodeProfile[],
  options: PlanOrderOptions = {}
): PlannedOrder {
  const now = options.now ?? new Date();
  const seed = options.seed ?? request.id ?? request.source.contentHash;
  const order = normalizeOrderRequest(request, now);
  const quote = quoteOrder(order);
  const computeTasks = splitOrderIntoComputeTasks(order);
  const verificationTasks = createVerificationTasks(order, computeTasks, seed);
  const tasks = [...computeTasks, ...verificationTasks];
  const { assignments, unassignedTasks } = assignTasksToNodes(tasks, nodes, { now, seed });
  const auditEvents = createPlanningAuditEvents(tasks, assignments, order.id, quote, now);

  return {
    order,
    quote,
    tasks,
    assignments,
    unassignedTasks,
    auditEvents
  };
}

function createPlanningAuditEvents(
  tasks: readonly TaskSpec[],
  assignments: readonly TaskAssignment[],
  orderId: string,
  quote: PlannedOrder["quote"],
  now: Date
): AuditEvent[] {
  let chain: AuditEvent[] = [];

  chain = [
    ...chain,
    appendAuditEvent(
      chain,
      {
        type: "order.planned",
        orderId,
        payload: {
          quote,
          taskCount: tasks.length
        }
      },
      now
    )
  ];

  for (const task of tasks) {
    chain = [
      ...chain,
      appendAuditEvent(
        chain,
        {
          type: "task.created",
          orderId,
          taskId: task.id,
          payload: {
            kind: task.kind,
            workload: task.workload,
            estimatedBytes: task.estimatedBytes,
            estimatedComputeUnits: task.estimatedComputeUnits,
            verification: task.verification
          }
        },
        now
      )
    ];
  }

  for (const assignment of assignments) {
    chain = [
      ...chain,
      appendAuditEvent(
        chain,
        {
          type: "task.assigned",
          orderId,
          taskId: assignment.taskId,
          actorNodeId: assignment.nodeId,
          payload: {
            assignmentId: assignment.id,
            role: assignment.role,
            score: assignment.score,
            leaseExpiresAt: assignment.leaseExpiresAt
          }
        },
        now
      )
    ];
  }

  return chain;
}
