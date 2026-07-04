import type { NodeProfile, TaskAssignment, TaskSpec, UnassignedTask } from "./types.js";
import { makeId } from "./ids.js";
import { createSeededRandom } from "./random.js";
import { scoreNodeForTask } from "./nodeScoring.js";

interface ScheduleOptions {
  now?: Date;
  seed?: string;
}

interface Candidate {
  node: NodeProfile;
  score: number;
  jitter: number;
}

export function assignTasksToNodes(
  tasks: readonly TaskSpec[],
  nodes: readonly NodeProfile[],
  options: ScheduleOptions = {}
): { assignments: TaskAssignment[]; unassignedTasks: UnassignedTask[] } {
  const now = options.now ?? new Date();
  const seed = options.seed ?? now.toISOString();
  const random = createSeededRandom(`${seed}:scheduler`);
  const assignments: TaskAssignment[] = [];
  const unassignedTasks: UnassignedTask[] = [];
  const virtualLeases = new Map<string, number>();
  const assignmentByTaskId = new Map<string, TaskAssignment>();

  const orderedTasks = [...tasks].sort((a, b) => {
    const stageDelta = taskStage(a) - taskStage(b);
    if (stageDelta !== 0) {
      return stageDelta;
    }
    return b.estimatedComputeUnits - a.estimatedComputeUnits;
  });

  for (const task of orderedTasks) {
    const candidates = nodes
      .map((node) => withVirtualLease(node, virtualLeases.get(node.id) ?? 0))
      .filter((node) => !isOriginalComputeNode(task, node.id, assignmentByTaskId))
      .map((node) => toCandidate(task, node, random.next()))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score + b.jitter - (a.score + a.jitter));

    const selected = candidates[0];

    if (!selected) {
      unassignedTasks.push({
        taskId: task.id,
        reasons: collectRejectionReasons(task, nodes, assignmentByTaskId)
      });
      continue;
    }

    const assignment = createAssignment(task, selected.node, selected.score, now);
    assignments.push(assignment);
    assignmentByTaskId.set(task.id, assignment);
    virtualLeases.set(selected.node.id, (virtualLeases.get(selected.node.id) ?? 0) + 1);
  }

  // Keep returned assignments in the same logical order as tasks.
  assignments.sort((a, b) => {
    const taskA = tasks.find((task) => task.id === a.taskId);
    const taskB = tasks.find((task) => task.id === b.taskId);
    return taskStage(taskA) - taskStage(taskB);
  });

  return { assignments, unassignedTasks };
}

function taskStage(task: TaskSpec | undefined): number {
  if (!task) {
    return 99;
  }
  if (task.kind === "canary") {
    return 0;
  }
  if (task.kind === "compute") {
    return 1;
  }
  return 2;
}

function isOriginalComputeNode(
  task: TaskSpec,
  nodeId: string,
  assignmentByTaskId: ReadonlyMap<string, TaskAssignment>
): boolean {
  const sourceTaskId = task.verification.verificationOfTaskId;
  if (task.kind !== "verification" || !sourceTaskId) {
    return false;
  }

  const originalAssignment = assignmentByTaskId.get(sourceTaskId);
  return originalAssignment?.nodeId === nodeId;
}

function toCandidate(task: TaskSpec, node: NodeProfile, jitter: number): Candidate {
  const score = scoreNodeForTask(task, node);
  return {
    node,
    score: score.score,
    jitter: jitter * 0.001
  };
}

function collectRejectionReasons(
  task: TaskSpec,
  nodes: readonly NodeProfile[],
  assignmentByTaskId: ReadonlyMap<string, TaskAssignment>
): string[] {
  const reasons = new Set<string>();

  for (const node of nodes) {
    if (isOriginalComputeNode(task, node.id, assignmentByTaskId)) {
      reasons.add("verification task cannot be assigned to original compute node");
      continue;
    }

    const score = scoreNodeForTask(task, node);
    for (const reason of score.reasons) {
      reasons.add(reason);
    }
  }

  return [...reasons].sort();
}

function createAssignment(task: TaskSpec, node: NodeProfile, score: number, now: Date): TaskAssignment {
  const leaseMs = Math.max(30_000, task.requirements.maxRuntimeSeconds * 1000 * 2);
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const role = task.kind === "canary" ? "canary" : task.kind;

  return {
    id: makeId("asg", {
      taskId: task.id,
      nodeId: node.id,
      assignedAt: now.toISOString()
    }),
    taskId: task.id,
    nodeId: node.id,
    role,
    score,
    assignedAt: now.toISOString(),
    leaseExpiresAt
  };
}

function withVirtualLease(node: NodeProfile, additionalLeases: number): NodeProfile {
  return {
    ...node,
    availability: {
      ...node.availability,
      currentLeases: node.availability.currentLeases + additionalLeases
    }
  };
}
