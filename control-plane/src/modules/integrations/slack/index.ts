import { App, KnownEventFromType, webApi } from "@slack/bolt";
import { FastifySlackReceiver } from "./receiver";
import { env } from "../../../utilities/env";
import { FastifyInstance } from "fastify";
import { logger } from "../../observability/logger";
import { getRunsByMetadata } from "../../workflows/metadata";
import { addMessageAndResume, createRunWithMessage } from "../../workflows/workflows";
import { AuthenticationError } from "../../../utilities/errors";
import { ulid } from "ulid";
import { and, eq, InferSelectModel, ne, sql } from "drizzle-orm";
import { db, integrations, workflowMessages } from "../../data";
import { nango } from "../nango";
import { InstallableIntegration } from "../types";
import { integrationSchema } from "../schema";
import { z } from "zod";

let app: App | undefined;

const THREAD_META_KEY = "slackThreadTs";
const CHANNEL_META_KEY = "slackChannel";

type MessageEvent = {
  event: KnownEventFromType<"message">;
  client: webApi.WebClient;
  clusterId: string;
};

export const slack: InstallableIntegration = {
  name: "slack",
  onDeactivate: async (
    clusterId: string,
    _: z.infer<typeof integrationSchema>,
    prevConfig: z.infer<typeof integrationSchema>
  ) => {
    logger.info("Deactivating Slack integration", {
      clusterId
    })

    if (!prevConfig.slack) {
      logger.warn("Can not deactivate Slack integration with no config")
      return
    }
    // Cleanup the Nango connection
    await deleteNangoConnection(prevConfig.slack.nangoConnectionId);
  },
  onActivate: async (
    clusterId: string,
    config: z.infer<typeof integrationSchema>,
    prevConfig: z.infer<typeof integrationSchema>
  ) => {
    logger.info("Activating Slack integration", {
      clusterId,
    })

    if (!config.slack) {
      logger.warn("Can not activate Slack integration with no config")
      return
    }

    // It can be possible for the same Nango session token to be used to create multiple connections
    // e.g, if the "try again" button.
    // This check will cleanup a previous connection if it is not the same
    if (
      prevConfig.slack
        && config.slack
        && prevConfig.slack.nangoConnectionId !== config.slack.nangoConnectionId
    ) {
      logger.warn("Slack integration has been overridden. Cleaning up previous Nango connection", {
        prevNangoConnectionId: prevConfig.slack.nangoConnectionId,
        nangoConnectionId: config.slack.nangoConnectionId
      })

      await deleteNangoConnection(prevConfig.slack.nangoConnectionId);
    }

    // If the user connects another cluster with the same Slack workspace, we cleanup the conflicting integrations
    await cleanupConflictingIntegrations(clusterId, config);
  },
  handleCall: async () => {
    logger.warn("Slack integration does not support calls");
  },
}

export const handleNewRunMessage = async ({
  message,
  metadata,
}: {
  message: {
    id: string;
    clusterId: string;
    runId: string;
    type: InferSelectModel<typeof workflowMessages>["type"];
    data: InferSelectModel<typeof workflowMessages>["data"];
  };
  metadata?: Record<string, string>;
}) => {
  if (message.type !== "agent") {
    return;
  }

  if (!metadata?.[THREAD_META_KEY] || !metadata?.[CHANNEL_META_KEY]) {
    return;
  }

  const integration = await integrationByCluster(message.clusterId);
  if (!integration || !integration.slack) {
    throw new Error(`Could not find Slack integration for cluster: ${message.clusterId}`);
  }

  const token = await getAccessToken(integration.slack.nangoConnectionId);
  if (!token) {
    throw new Error(`Could not fetch access token for Slack integration: ${integration.slack.nangoConnectionId}`);
  }

  const client = new webApi.WebClient(token)

  if ("message" in message.data && message.data.message) {
    client?.chat.postMessage({
      thread_ts: metadata[THREAD_META_KEY],
      channel: metadata[CHANNEL_META_KEY],
      mrkdwn: true,
      text: message.data.message,
    });
  } else {
    logger.warn("Slack initialted message does not have content");
  }
};

export const start = async (fastify: FastifyInstance) => {
  const SLACK_SIGNING_SECRET = env.SLACK_SIGNING_SECRET;

  if (!SLACK_SIGNING_SECRET) {
    logger.info("Missing Slack environment variables. Skipping Slack integration.");
    return;
  }

  app = new App({
    authorize: async ({ teamId, enterpriseId }) => {
      if (!teamId) {
        logger.warn("Slack event is missing teamId");
        throw new Error("Slack event is missing teamId");
      }
      const integration = await integrationByTeam(teamId);

      if (!integration || !integration.slack) {
        logger.warn("Could not find Slack integration for teamId", {
          teamId
        });
        throw new Error("Could not find Slack integration for teamId");
      }

      const token = await getAccessToken(integration.slack.nangoConnectionId)
      if (!token) {
        throw new Error(`Could not fetch access token for Slack integration: ${integration.slack.nangoConnectionId}`);
      }

      return {
        teamId,
        enterpriseId,
        botUserId: integration.slack.botUserId,
        botToken: token,
      }
    },
    receiver: new FastifySlackReceiver({
      signingSecret: SLACK_SIGNING_SECRET,
      path: "/slack/events",
      fastify,
    }),
  });

  // Event listener for mentions
  app.event("app_mention", async ({ event, client }) => {
    logger.info("Received mention event. Responding.", event);

    client.chat.postMessage({
      thread_ts: event.ts,
      channel: event.channel,
      mrkdwn: true,
      text: "Hey! Currently, I can only respond to direct messages.",
    });
  });

  // Event listener for direct messages
  app.event("message", async ({ event, client, context }) => {
    logger.info("Received message event. Responding.", event);

    if (isBotMessage(event)) {
      logger.info("Received message from bot. Ignoring.", event);
      return;
    }

    if (!isDirectMessage(event)) {
      logger.info("Received message from channel. Ignoring.", event);
      return;
    }

    const teamId = context.teamId

    if (!teamId) {
      logger.warn("Received message without teamId. Ignoring.");
      return;
    }

    const integration = await integrationByTeam(teamId);
    if (!integration) {
      logger.warn("Could not Slack integration for teamId.", {
        teamId,
      });
      return;
    }

    try {
      if (hasThread(event)) {
        await handleExistingThread({
          event,
          client,
          clusterId: integration.cluster_id,
        });
      } else {
        await handleNewThread({
          event,
          client,
          clusterId: integration.cluster_id,
        });
      }
    } catch (error) {
      if (error instanceof AuthenticationError) {
        client.chat.postMessage({
          thread_ts: event.ts,
          channel: event.channel,
          text: `Sorry, I am having trouble authenticating you.\n\nPlease ensure your Inferable account has access to cluster <${env.APP_ORIGIN}/clusters/${integration}|${integration}>.`,
        });
        return;
      }

      logger.error("Error responding to Direct Message", { error });
    }
  });

  await app.start();
};

export const stop = async () => await app?.stop();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hasThread = (e: any): e is { thread_ts: string } => {
  return typeof e?.thread_ts === "string";
};

const isDirectMessage = (e: KnownEventFromType<"message">): boolean => {
  return e.channel_type === "im";
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isBotMessage = (e: any): boolean => {
  return typeof e?.bot_id === "string";
};

const integrationByTeam = async (teamId: string) => {
  const [result] = await db.select({
    cluster_id: integrations.cluster_id,
    slack: integrations.slack,
  })
    .from(integrations)
    .where(sql`slack->>'teamId' = ${teamId}`);

  return result;
};

const integrationByCluster = async (clusterId: string) => {
  const [result] = await db.select({
    cluster_id: integrations.cluster_id,
    slack: integrations.slack,
  })
    .from(integrations)
    .where(
      eq(integrations.cluster_id, clusterId)
    );

  return result;
};


const getAccessToken = async (connectionId: string) => {
  if (!nango) {
    throw new Error("Nango is not configured");
  }

  const result = await nango.getToken(env.NANGO_SLACK_INTEGRATION_ID, connectionId);
  if (typeof result !== "string") {
    return null;
  }

  return result;
};

const cleanupConflictingIntegrations = async (clusterId: string, config: z.infer<typeof integrationSchema>) => {
  if (!config.slack) {
    return;
  }

  const conflicts = await db
    .select({
      cluster_id: integrations.cluster_id,
      slack: integrations.slack,
    })
    .from(integrations)
    .where(
      and(
        sql`slack->>'teamId' = ${config.slack.teamId}`,
        ne(integrations.cluster_id, clusterId)
      )
    );

  if (conflicts.length) {
    logger.info("Removed conflicting Slack integrations", {
      conflicts: conflicts.map((conflict) => conflict.cluster_id)
    })

    // Cleanup Slack integrations from DB
    await db
    .delete(integrations)
    .where(
      and(
        sql`slack->>'teamId' = ${config.slack.teamId}`,
        ne(integrations.cluster_id, clusterId)
      )
    );

    // Cleanup Nango connections
    await Promise.allSettled(conflicts.map(async (conflict) => {
      if (conflict.slack) {
        await deleteNangoConnection(conflict.slack.nangoConnectionId);
      }
    }));

  }
}

const deleteNangoConnection = async (connectionId: string) => {
  if (!nango) {
    throw new Error("Nango is not configured");
  }

  await nango.deleteConnection(
    env.NANGO_SLACK_INTEGRATION_ID,
    connectionId
  );
};


const handleNewThread = async ({ event, client, clusterId }: MessageEvent) => {
  let thread = event.ts;
  // If this message is part of a thread, associate the run with the thread rather than the message
  if (hasThread(event)) {
    thread = event.thread_ts;
  }

  if ("text" in event && event.text) {
    const run = await createRunWithMessage({
      clusterId,
      message: event.text,
      type: "human",
      metadata: {
        [THREAD_META_KEY]: thread,
        [CHANNEL_META_KEY]: event.channel,
      },
    });

    client.chat.postMessage({
      thread_ts: thread,
      channel: event.channel,
      mrkdwn: true,
      text: `On it. I will get back to you soon.\nRun ID: <${env.APP_ORIGIN}/clusters/${clusterId}/runs/${run.id}|${run.id}>`,
    });

    return;
  }

  throw new Error("Event had no text");
};

const handleExistingThread = async ({ event, client, clusterId }: MessageEvent) => {
  if ("text" in event && event.text) {
    if (!hasThread(event)) {
      throw new Error("Event had no thread_ts");
    }

    const [run] = await getRunsByMetadata({
      clusterId,
      key: THREAD_META_KEY,
      value: event.thread_ts,
      limit: 1,
    });

    // Message is within a thread which already has a Run, continue
    if (run) {
      await addMessageAndResume({
        id: ulid(),
        clusterId: run.clusterId,
        runId: run.id,
        message: event.text,
        type: "human",
      });
    } else {
      // Message is in a thread, but does't have a Run, start a new one
      // TODO: Inferable doesn't have context for the original message, we should include this
      await handleNewThread({
        event,
        client,
        clusterId,
      });
    }

    return;
  }

  throw new Error("Event had no text");
};
