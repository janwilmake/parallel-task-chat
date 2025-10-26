import { Parallel } from "parallel-web";

interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
}

interface QueueItem {
  content: string;
  type: "reasoning" | "content";
  isLast?: boolean;
}

function createThrottledStream(
  requestId: string,
  model: string,
  includeUsage: boolean = false
) {
  const encoder = new TextEncoder();
  let queue: QueueItem[] = [];
  let isProcessing = false;
  let isComplete = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const sendChunk = (delta: any, finishReason: string | null = null) => {
    const chunk = {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };

    if (finishReason === "stop" && includeUsage) {
      (chunk as any).usage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
    }

    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const processQueue = async () => {
    if (isProcessing || queue.length === 0) return;

    isProcessing = true;

    while (queue.length > 0) {
      const item = queue.shift()!;
      const content = item.content;

      // Check if this is the last item or if we're complete and should go faster
      const shouldGoFast = item.isLast || (isComplete && queue.length === 0);
      const charsPerChunk = shouldGoFast ? content.length : 5;
      const delay = shouldGoFast ? 10 : 50;

      let position = 0;

      while (position < content.length) {
        // If there's a new item in queue and we're not on the last item,
        // send remaining content in one go
        if (queue.length > 0 && !item.isLast) {
          const remaining = content.slice(position);
          if (remaining) {
            const deltaKey =
              item.type === "reasoning" ? "reasoning_content" : "content";
            sendChunk({ [deltaKey]: remaining });
          }
          break;
        }

        const chunk = content.slice(position, position + charsPerChunk);
        position += charsPerChunk;

        const deltaKey =
          item.type === "reasoning" ? "reasoning_content" : "content";
        sendChunk({ [deltaKey]: chunk });

        // Don't delay on the last chunk of the last item
        if (position < content.length || (!item.isLast && queue.length === 0)) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    isProcessing = false;

    // If we're complete and queue is empty, send final chunks
    if (isComplete && queue.length === 0) {
      sendChunk({}, "stop");
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  };

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;

      // Send initial role chunk
      sendChunk({ role: "assistant" });
    },
  });

  return {
    stream,
    addToQueue: (
      content: string,
      type: "reasoning" | "content" = "content",
      isLast: boolean = false
    ) => {
      if (content) {
        queue.push({
          content: sanitizeContent(content) + "\n\n",
          type,
          isLast,
        });
        processQueue();
      }
    },
    complete: () => {
      isComplete = true;
      processQueue();
    },
    error: (errorMessage: string) => {
      queue.push({
        content: `**Error**: ${errorMessage}\n\n`,
        type: "content",
        isLast: true,
      });
      isComplete = true;
      processQueue();
    },
  };
}

export default {
  fetch: async (request: Request, env: any) => {
    const url = new URL(request.url);

    if (url.pathname !== "/chat/completions" || request.method !== "POST") {
      return new Response(
        `Only POST /chat/completions is supported
        

curl --no-buffer -X POST https://taskchat.p0web.com/chat/completions   -H "Content-Type: application/json"   -H "Authorization: Bearer YOUR_KEY"   -d '{
    "model": "base",
    "messages": [
      {
        "role": "user", 
        "content": "What was the GDP of France in 2023?"
      }
    ],
    "stream": true,
    "stream_options": {
      "include_usage": true
    }
  }'
`,
        {
          status: 404,
        }
      );
    }

    const apiKey = request.headers.get("Authorization")?.replace("Bearer ", "");
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Authorization header with API key required",
            type: "invalid_request_error",
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    let body: ChatCompletionRequest;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: {
            message: "Invalid JSON in request body",
            type: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.stream) {
      return new Response(
        JSON.stringify({
          error: {
            message: "This proxy requires stream: true to be set",
            type: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const requestId = `chatcmpl-${Date.now()}`;
    const parallel = new Parallel({ apiKey });

    try {
      // Create task run with streaming
      const taskRun = await parallel.beta.taskRun.create({
        input: JSON.stringify(body.messages),
        processor: body.model,
        task_spec: { output_schema: { type: "text" } },
        enable_events: true,
        betas: ["events-sse-2025-07-24"],
        // not sure how to add these in the /chat/completions
        source_policy: undefined,
        mcp_servers: undefined,
        metadata: undefined,
        webhook: undefined,
      });

      let lastSourcesConsidered = 0;

      // Create throttled stream
      const throttledStream = createThrottledStream(
        requestId,
        body.model,
        body.stream_options?.include_usage
      );

      throttledStream.addToQueue(
        `I've started a ${body.model} task to answer your question.`,
        "reasoning"
      );

      // Process events in the background
      (async () => {
        try {
          const eventStream = await parallel.beta.taskRun.events(
            taskRun.run_id
          );

          for await (const event of eventStream) {
            console.log("Received event:", event);

            switch (event.type) {
              case "task_run.progress_msg.plan":
              case "task_run.progress_msg.search":
              case "task_run.progress_msg.tool_call":
              case "task_run.progress_msg.exec_status":
                if (event.message) {
                  throttledStream.addToQueue(event.message, "reasoning");
                }
                break;

              case "task_run.progress_stats":
                if (
                  event.source_stats &&
                  event.source_stats.num_sources_considered >
                    lastSourcesConsidered
                ) {
                  lastSourcesConsidered =
                    event.source_stats.num_sources_considered;

                  const statsMessage = `Processing ${
                    event.source_stats.num_sources_considered || 0
                  } sources, read ${event.source_stats.num_sources_read || 0}`;

                  throttledStream.addToQueue(statsMessage, "reasoning");
                }
                break;

              case "task_run.state":
                if (
                  event.run &&
                  event.run.status === "completed" &&
                  event.output
                ) {
                  const resultJson = {
                    type: event.output.type,
                    basis: event.output.basis,
                    content: event.output.content,
                    output_schema: (
                      event.output as Parallel.TaskRun.TaskRunJsonOutput
                    ).output_schema,
                    beta_fields: event.output.beta_fields,
                    id: event.run.run_id,
                    status: event.run.status,
                    created_at: event.run.created_at,
                    modified_at: event.run.modified_at,
                    error: event.run.error,
                    processor: event.run.processor,
                    warnings: event.run.warnings,
                  };

                  const safeJsonString = JSON.stringify(resultJson, null, 2);
                  const finalContent = "```json\n" + safeJsonString + "\n```";

                  throttledStream.addToQueue(finalContent, "content", true);
                  throttledStream.complete();
                  return;
                } else if (
                  event.run &&
                  (event.run.status === "failed" ||
                    event.run.status === "cancelled")
                ) {
                  const errorContent = `**Error**: Task ${event.run.status} - ${
                    event.run.error?.message || "Unknown error"
                  }`;

                  throttledStream.addToQueue(errorContent, "content", true);
                  throttledStream.complete();
                  return;
                }
                break;

              case "error":
                throttledStream.error(event.error?.message || "Unknown error");
                return;

              default:
                console.log("Unhandled event type:", event.type);
                break;
            }
          }

          // Fallback completion
          throttledStream.complete();
        } catch (error) {
          console.error("Stream error:", error);
          throttledStream.error(error.message || "Stream processing failed");
        }
      })();

      return new Response(throttledStream.stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    } catch (error) {
      console.error("Task creation error:", error);
      return new Response(
        JSON.stringify({
          error: {
            message: `Task creation failed: ${error.message}`,
            type: "internal_error",
          },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};

const sanitizeContent = (content: string): string => {
  if (typeof content !== "string") {
    return String(content);
  }

  // Remove or replace problematic characters that might break JSON
  return content
    .replace(/[\x00-\x1F\x7F]/g, "") // Remove control characters
    .replace(/\\/g, "\\\\") // Escape backslashes
    .replace(/"/g, '\\"') // Escape quotes
    .trim();
};
