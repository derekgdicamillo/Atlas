import type { SupabaseClient } from "@supabase/supabase-js";

export interface CausalNode {
  id: string;
  kind: "metric" | "action" | "event";
  name: string;
  description?: string;
  unit?: string;
  metadata?: any;
}

export interface CausalEdge {
  id: string;
  from_node: string;
  to_node: string;
  effect_size: number | null;
  effect_ci: { low: number; high: number } | null;
  evidence: any[];
  status: "hypothesized" | "observed" | "falsified";
  proposed_by: "pc-algo" | "llm" | "natural-experiment" | "manual";
  approved: boolean;
  approved_by?: string;
  approved_at?: string;
  notes?: string;
}

export async function findCauses(
  supabase: SupabaseClient,
  metric_name: string,
  since?: Date
): Promise<CausalEdge[]> {
  const { data: node } = await supabase
    .from("causal_nodes")
    .select("id")
    .eq("name", metric_name)
    .single();
  if (!node) return [];

  let q = supabase
    .from("causal_edges")
    .select("*")
    .eq("to_node", (node as any).id)
    .eq("approved", true)
    .eq("status", "observed");
  if (since) q = q.gte("updated_at", since.toISOString()) as any;
  const { data } = await (q as any);
  return (data ?? []) as CausalEdge[];
}

export async function findEffects(
  supabase: SupabaseClient,
  action_name: string,
  horizon_days?: number
): Promise<CausalEdge[]> {
  const { data: node } = await supabase
    .from("causal_nodes")
    .select("id")
    .eq("name", action_name)
    .single();
  if (!node) return [];

  const { data } = await supabase
    .from("causal_edges")
    .select("*")
    .eq("from_node", (node as any).id)
    .eq("approved", true);
  return ((data ?? []) as CausalEdge[]).filter((e) => e.status !== "falsified");
}

function composeReasoning(path: CausalEdge[]): string {
  return path
    .map((e, i) => `${i + 1}. edge ${e.id.slice(0, 8)}… effect ${e.effect_size ?? "?"}`)
    .join(" → ");
}

export async function walkPath(
  supabase: SupabaseClient,
  from_name: string,
  to_name: string,
  max_depth = 4
): Promise<{ path: CausalEdge[]; reasoning: string } | null> {
  const { data: fromNode } = await supabase
    .from("causal_nodes").select("id").eq("name", from_name).single();
  if (!fromNode) return null;
  const { data: toNode } = await supabase
    .from("causal_nodes").select("id").eq("name", to_name).single();
  if (!toNode) return null;

  const startId = (fromNode as any).id;
  const goalId = (toNode as any).id;

  const visited = new Set<string>([startId]);
  const queue: Array<{ node: string; path: CausalEdge[] }> = [{ node: startId, path: [] }];
  while (queue.length) {
    const { node, path } = queue.shift()!;
    if (path.length >= max_depth) continue;
    const { data: edges } = await supabase
      .from("causal_edges")
      .select("*")
      .eq("from_node", node)
      .eq("approved", true)
      .eq("status", "observed");
    for (const e of (edges ?? []) as CausalEdge[]) {
      if (e.to_node === goalId) {
        return { path: [...path, e], reasoning: composeReasoning([...path, e]) };
      }
      if (!visited.has(e.to_node)) {
        visited.add(e.to_node);
        queue.push({ node: e.to_node, path: [...path, e] });
      }
    }
  }
  return null;
}

export async function pendingApprovals(
  supabase: SupabaseClient,
  limit = 20
): Promise<CausalEdge[]> {
  const { data } = await supabase
    .from("causal_edges")
    .select("*")
    .eq("approved", false)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as CausalEdge[];
}

export async function approveEdge(
  supabase: SupabaseClient,
  edge_id: string,
  approver: "derek" | "esther"
): Promise<void> {
  const { data: edge } = await supabase
    .from("causal_edges")
    .select("proposed_by, effect_size, status")
    .eq("id", edge_id)
    .single();
  const update: any = {
    approved: true,
    approved_by: approver,
    approved_at: new Date().toISOString(),
  };
  if (
    (edge as any)?.proposed_by === "natural-experiment" &&
    (edge as any)?.effect_size != null
  ) {
    update.status = "observed";
  }
  await supabase.from("causal_edges").update(update).eq("id", edge_id);
}

export async function falsifyEdge(
  supabase: SupabaseClient,
  edge_id: string,
  reason: string
): Promise<void> {
  await supabase
    .from("causal_edges")
    .update({
      status: "falsified",
      notes: `falsified: ${reason}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", edge_id);
}

export async function manuallyAddEdge(
  supabase: SupabaseClient,
  opts: {
    from_node: string;
    to_node: string;
    effect_size?: number;
    evidence?: any[];
    notes?: string;
  }
): Promise<CausalEdge> {
  const row = {
    from_node: opts.from_node,
    to_node: opts.to_node,
    effect_size: opts.effect_size ?? null,
    evidence: opts.evidence ?? [],
    status: opts.effect_size != null ? "observed" : "hypothesized",
    proposed_by: "manual",
    approved: true,
    approved_by: "manual",
    approved_at: new Date().toISOString(),
    notes: opts.notes ?? null,
  };
  const { data } = await supabase.from("causal_edges").insert(row).select().single();
  return data as CausalEdge;
}

export async function ensureNode(
  supabase: SupabaseClient,
  opts: { kind: CausalNode["kind"]; name: string; description?: string; unit?: string }
): Promise<CausalNode> {
  const { data: existing } = await supabase
    .from("causal_nodes")
    .select("*")
    .eq("name", opts.name)
    .maybeSingle();
  if (existing) return existing as CausalNode;
  const { data } = await supabase
    .from("causal_nodes")
    .insert({
      kind: opts.kind,
      name: opts.name,
      description: opts.description ?? null,
      unit: opts.unit ?? null,
    })
    .select()
    .single();
  return data as CausalNode;
}

export async function handleDagCommand(
  supabase: SupabaseClient,
  args: string[],
  caller: string
): Promise<string> {
  const sub = (args[0] ?? "").toLowerCase();
  switch (sub) {
    case "pending": {
      const pending = await pendingApprovals(supabase, 20);
      if (!pending.length) return "**DAG pending**: 0 edges.";
      const lines = ["**DAG pending edges**", ""];
      for (const e of pending) {
        const conf = e.evidence?.[0]?.confidence ?? e.evidence?.[0]?.stability ?? "—";
        lines.push(
          `\`${e.id.slice(0, 8)}\` ${e.from_node.slice(0, 8)}→${e.to_node.slice(0, 8)} (${e.proposed_by}, conf=${conf})`
        );
      }
      lines.push(``, `Approve via: \`/dag approve <id>\` or \`/dag falsify <id> <reason>\``);
      return lines.join("\n");
    }
    case "approve": {
      const id = args[1];
      if (!id) return "Usage: `/dag approve <edge_id>`";
      const approver = caller.toLowerCase().includes("esther") ? "esther" : "derek";
      await approveEdge(supabase, id, approver);
      return `Edge \`${id.slice(0, 8)}\` approved by ${approver}.`;
    }
    case "falsify": {
      const id = args[1];
      const reason = args.slice(2).join(" ") || "no reason given";
      if (!id) return "Usage: `/dag falsify <edge_id> <reason>`";
      await falsifyEdge(supabase, id, reason);
      return `Edge \`${id.slice(0, 8)}\` falsified.`;
    }
    case "walk": {
      const fromName = args[1];
      if (!fromName) return "Usage: `/dag walk <node_name>`";
      const downstream = await findEffects(supabase, fromName);
      if (!downstream.length) return `No downstream effects from \`${fromName}\`.`;
      const lines = [`**${fromName} → effects**`, ""];
      for (const e of downstream) {
        lines.push(
          `→ ${e.to_node.slice(0, 8)} (effect=${e.effect_size ?? "?"}, ${e.proposed_by})`
        );
      }
      return lines.join("\n");
    }
    case "stats": {
      const { count: nodeCount } = await supabase
        .from("causal_nodes")
        .select("*", { count: "exact", head: true });
      const { count: pendingCount } = await supabase
        .from("causal_edges")
        .select("*", { count: "exact", head: true })
        .eq("approved", false);
      const { count: observedCount } = await supabase
        .from("causal_edges")
        .select("*", { count: "exact", head: true })
        .eq("approved", true)
        .eq("status", "observed");
      return [
        `**DAG stats**`,
        ``,
        `Nodes: ${nodeCount ?? 0}`,
        `Observed (approved) edges: ${observedCount ?? 0}`,
        `Pending: ${pendingCount ?? 0}`,
      ].join("\n");
    }
    default:
      return [
        `**DAG commands**`,
        `\`/dag pending\` — list edges awaiting approval`,
        `\`/dag approve <id>\` — approve a hypothesized edge`,
        `\`/dag falsify <id> <reason>\` — mark falsified`,
        `\`/dag walk <node_name>\` — show downstream effects`,
        `\`/dag stats\` — counts`,
      ].join("\n");
  }
}
