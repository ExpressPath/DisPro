import { verifyAuditChain } from "../domain/auditLog.js";
import { microYenToYen } from "../domain/pricing.js";
import type { OrderRequest, Priority, VerificationLevel, WorkloadKind } from "../domain/types.js";
import { sampleNodes } from "../sample/sampleNodes.js";
import { planOrder } from "../services/orderOrchestrator.js";

const args = parseArgs(process.argv.slice(2));

const request: OrderRequest = {
  customerId: "customer_demo_001",
  source: {
    kind: "file",
    uri: args.uri ?? "dispro://upload/demo/manual.pdf",
    byteSize: args.bytes ?? 37_500_000,
    contentHash: args.hash ?? "0f4b2b44a27f6a339c9bdc1c8d15d39e9d2c24b3528e8aa2f6b2b2f3a7d98a01"
  },
  workload: args.workload ?? "pdf.compress",
  priority: args.priority ?? "standard",
  verificationLevel: args.verification ?? "standard",
  requirements: {
    allowMobileVerification: true
  }
};

const plan = planOrder(request, sampleNodes, {
  now: new Date("2026-07-04T12:00:00.000Z"),
  seed: "demo-seed"
});

const computeTasks = plan.tasks.filter((task) => task.kind === "compute");
const verificationTasks = plan.tasks.filter((task) => task.kind === "verification");
const canaryTasks = plan.tasks.filter((task) => task.kind === "canary");
const latestAuditHash = plan.auditEvents.at(-1)?.eventHash ?? "none";
const assignmentByNode = countBy(plan.assignments.map((assignment) => assignment.nodeId));

console.log("Dispro 注文計画シミュレーション");
console.log("--------------------------------");
console.log(`注文 ID: ${plan.order.id}`);
console.log(`ワークロード: ${plan.order.workload}`);
console.log(`入力サイズ: ${plan.order.source.byteSize.toLocaleString()} bytes`);
console.log(`見積額: ${microYenToYen(plan.quote.totalMicroYen).toFixed(4)} 円`);
console.log(`  subtotal: ${microYenToYen(plan.quote.subtotalMicroYen).toFixed(4)} 円`);
console.log(`  platform fee: ${microYenToYen(plan.quote.platformFeeMicroYen).toFixed(4)} 円`);
console.log(`タスク数: compute=${computeTasks.length}, verification=${verificationTasks.length}, canary=${canaryTasks.length}`);
console.log(`割り当て成功: ${plan.assignments.length}/${plan.tasks.length}`);
console.log(`監査ログ: ${plan.auditEvents.length} events, valid=${verifyAuditChain(plan.auditEvents)}`);
console.log(`最新監査ハッシュ: ${latestAuditHash}`);
console.log("");
console.log("ノード別割り当て:");

for (const [nodeId, count] of Object.entries(assignmentByNode).sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`- ${nodeId}: ${count}`);
}

if (plan.unassignedTasks.length > 0) {
  console.log("");
  console.log("未割り当て:");
  for (const task of plan.unassignedTasks) {
    console.log(`- ${task.taskId}: ${task.reasons.join(", ")}`);
  }
}

function parseArgs(argv: string[]): {
  bytes?: number;
  hash?: string;
  priority?: Priority;
  uri?: string;
  verification?: VerificationLevel;
  workload?: WorkloadKind;
} {
  const parsed: ReturnType<typeof parseArgs> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key?.startsWith("--") || value === undefined) {
      continue;
    }

    index += 1;

    if (key === "--bytes") {
      parsed.bytes = Number.parseInt(value, 10);
    } else if (key === "--hash") {
      parsed.hash = value;
    } else if (key === "--priority") {
      parsed.priority = value as Priority;
    } else if (key === "--uri") {
      parsed.uri = value;
    } else if (key === "--verification") {
      parsed.verification = value as VerificationLevel;
    } else if (key === "--workload") {
      parsed.workload = value as WorkloadKind;
    }
  }

  return parsed;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}
