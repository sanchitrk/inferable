"use client";

import { WorkflowTimeline, DeploymentNode } from "@/components/workflow-timeline";
import { Run } from "@/components/run";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Bot, Terminal, Clock } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { useAuth, useUser } from "@clerk/nextjs";
import { client } from "@/client/client";
import { createErrorToast } from "@/lib/utils";
import { ClientInferResponseBody } from "@ts-rest/core";
import { contract } from "@/client/contract";
import { formatRelative } from "date-fns";

export default function WorkflowExecutionDetailsPage({
  params,
}: {
  params: {
    clusterId: string;
    workflowName: string;
    executionId: string;
  };
}) {
  const { getToken } = useAuth();
  const user = useUser();

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [timeline, setTimeline] =
    useState<ClientInferResponseBody<typeof contract.getWorkflowExecutionTimeline>>();

  const fetchWorkflowExecution = useCallback(async () => {
    if (!params.clusterId || !user.isLoaded) {
      return;
    }
    setIsLoading(true);
    try {
      const result = await client.getWorkflowExecutionTimeline({
        headers: {
          authorization: `Bearer ${await getToken()}`,
        },
        params: {
          clusterId: params.clusterId,
          workflowName: params.workflowName,
          executionId: params.executionId,
        },
      });

      if (result.status === 200) {
        setTimeline(result.body);
      } else {
        createErrorToast(result, "Failed to load workflow executions");
      }
    } catch (error) {
      createErrorToast(error, "Failed to load workflow executions");
    } finally {
      setIsLoading(false);
    }
  }, [params.clusterId, params.workflowName, params.executionId, user.isLoaded, getToken]);

  useEffect(() => {
    fetchWorkflowExecution();
  }, [fetchWorkflowExecution]);

  const deploymentNodes =
    timeline?.runs.map(run => ({
      id: run.id,
      title: run.type === "single-step" ? "Single Step Agent" : "Multi Step Agent",
      label: run.name,
      color: run.status === "failed" ? "bg-red-200" : "bg-gray-200",
      icon: React.createElement(Bot),
      interactive: true,
    })) ?? [];

  const handleNodeClick = (node: DeploymentNode) => {
    setSelectedRunId(selectedRunId ? null : node.id);
  };

  if (isLoading || !timeline) {
    return <div>Loading...</div>;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">{params.workflowName}</h1>
        </div>
      </div>

      <div className="grid md:grid-cols-4 sm:grid-cols-1 gap-4 mb-6">
        <div className="flex items-center gap-3 rounded-lg border p-4">
          <div className="p-2 rounded-lg bg-gray-100">
            <Terminal className="w-5 h-5 text-gray-600" />
          </div>
          <div>
            <div className="text-sm text-gray-500">Version</div>
            <div className="font-medium">{timeline.execution.workflowVersion}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border p-4">
          <div className="p-2 rounded-lg bg-gray-100">
            <Terminal className="w-5 h-5 text-gray-600" />
          </div>
          <div>
            <div className="text-sm text-gray-500">Execution ID</div>
            <div className="font-medium">{params.executionId}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border p-4">
          <div className="p-2 rounded-lg bg-gray-100">
            <Clock className="w-5 h-5 text-gray-600" />
          </div>
          <div>
            <div className="text-sm text-gray-500">Triggered</div>
            <div className="font-medium">
              {formatRelative(new Date(timeline.execution.createdAt), new Date())}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border p-4">
          <div className="p-2 rounded-lg bg-gray-100">
            <div className="w-2 h-2 rounded-full"></div>
          </div>
          <div>
            <div className="text-sm text-gray-500">Status</div>
            <div className="font-medium">{timeline.job.status}</div>
          </div>
        </div>
      </div>

      <Dialog open={!!selectedRunId} onOpenChange={() => setSelectedRunId(null)}>
        <DialogContent className="max-w-[90vw] w-[1200px] p-1">
          <div className="flex-1 overflow-hidden">
            {selectedRunId && (
              <Run clusterId={params.clusterId} runId={selectedRunId} interactiveOveride={false} />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <WorkflowTimeline
        nodes={deploymentNodes}
        onNodeClick={handleNodeClick}
        className="w-full h-[70vh] p-10 rounded-lg border shadow-sm"
      />
    </div>
  );
}
