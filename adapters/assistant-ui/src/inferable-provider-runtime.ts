import {
  AppendMessage,
  ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useRun } from "@inferable/react";
import { agentDataSchema, genericMessageDataSchema, resultDataSchema } from "@inferable/react/dist/contract";
import { z } from "zod";

/**
 * Options for configuring runtime execution.
 */
type RuntimeOptions = {
  /** ID of the cluster to connect to */
  clusterId: string;

  /** Optional base URL for the API. Defaults to production URL if not specified */
  baseUrl?: string;

  /** Optional, provided if you want to resume an existing run */
  runId?: string;
} & (
  | {
      /**
       * The cluster API secret to use for authentication.
       * This is not recommended as the key will be available in the browser.
       *
       * @see https://docs.inferable.ai/pages/auth
       */
      apiSecret: string;
      customAuthToken?: never;
    }
  | {
      /**
       * A custom auth token to use for authentication.
       *
       * @see https://docs.inferable.ai/pages/custom-auth
       */
      customAuthToken: string;
      apiSecret?: never;
    }
);

export function useInferableRuntime({
  clusterId,
  apiSecret,
  customAuthToken,
  runId,
  baseUrl
}: RuntimeOptions) {
  const { messages, run, createMessage } = useRun({
    clusterId,
    baseUrl,
    ...(customAuthToken
      ? { authType: "custom" as const, customAuthToken }
      : { authType: "cluster" as const, apiSecret: apiSecret! }
    ),
  });

  const onNew = async (message: AppendMessage) => {
    if (message.content[0]?.type !== "text")
      throw new Error("Only text messages are supported");

    const input = message.content[0].text;

    await createMessage({
      message: input,
      type: "human",
    });
  };

  const isRunning = run?.status ? ["running", "pending"].includes(run.status) : false;

  return {
    runtime: useExternalStoreRuntime({
      isRunning,
      messages,
      convertMessage: (message) => convertMessage(message, messages),
      onNew,
    }),
    run,
  }
}

const convertMessage = (message: any, allMessages: any): ThreadMessageLike => {
  switch (message.type) {
    case "human": {
      const parsedData = genericMessageDataSchema.parse(message.data);
      return {
        id: message.id,
        role: "user",
        content: [{
          type: "text",
          text: parsedData.message
        }]
      }
    }
    case "agent": {
      const parsedData = agentDataSchema.parse(message.data);
      const content = [];


      if (parsedData.message) {
        content.push({
          type: "text" as const,
          text: parsedData.message
        });
      }

      if (parsedData.invocations) {

        parsedData.invocations.forEach((invocation) => {

          // Attempt to find corresponding `invocation-result` message
          let result = null;
          allMessages.forEach((message: any) => {
            if ('type' in message && message.type !== "invocation-result") {
              return false
            }

            const parsedResult = resultDataSchema.parse(message.data);

            if (parsedResult.id === invocation.id) {
              result = parsedResult.result;
              return true;
            }
          });

          content.push({
            type: "tool-call",
            toolName: invocation.toolName,
            args: invocation.input,
            toolCallId: invocation.id,
            result
          });
        })
      }

      if (content.length === 0) {
        return {
          id: message.id,
          role: "system",
          content: "MESSAGE HAS NO CONTENT"
        }
      }

      return {
        id: message.id,
        role: "assistant",
        content: content
      }
    }
  }

  return {
    id: message.id,
    role: "system",
    content: [{
      type: "text",
      text: `UNKNON MESSAGE TYPE: ${message.type}`
    }],
  };
}
