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
      });

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            // Send initial role chunk
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant" },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`
              )
            );

            // Stream task run events
            const eventStream = await parallel.beta.taskRun.events(
              taskRun.run_id
            );

            for await (const event of eventStream) {
              console.log("Received event:", event);

              // Handle different event types based on actual Parallel AI spec
              switch (event.type) {
                case "task_run.progress_msg.plan":
                case "task_run.progress_msg.search":
                case "task_run.progress_msg.tool_call":
                case "task_run.progress_msg.exec_status":
                  // Stream progress messages as reasoning_content
                  if (event.message) {
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({
                          id: requestId,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: body.model,
                          choices: [
                            {
                              index: 0,
                              delta: { reasoning_content: event.message },
                              finish_reason: null,
                            },
                          ],
                        })}\n\n`
                      )
                    );
                  }
                  break;

                case "task_run.progress_stats":
                  // Handle progress stats if needed
                  if (event.source_stats) {
                    const statsMessage = `Processing ${
                      event.source_stats.num_sources_considered || 0
                    } sources, read ${
                      event.source_stats.num_sources_read || 0
                    }`;
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({
                          id: requestId,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: body.model,
                          choices: [
                            {
                              index: 0,
                              delta: { reasoning_content: statsMessage },
                              finish_reason: null,
                            },
                          ],
                        })}\n\n`
                      )
                    );
                  }
                  break;

                case "task_run.state":
                  // Task run state change
                  if (
                    event.run &&
                    event.run.status === "completed" &&
                    event.output
                  ) {
                    // Format final output as JSON codeblock
                    const resultJson = {
                      basis: event.output.basis,
                      output: event.output.content,
                      run_info: {
                        id: event.run.run_id,
                        status: event.run.status,
                        created_at: event.run.created_at,
                        modified_at: event.run.modified_at,
                      },
                    };

                    const finalContent = `\`\`\`json\n${JSON.stringify(
                      resultJson,
                      null,
                      2
                    )}\n\`\`\``;

                    // Send final content
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({
                          id: requestId,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: body.model,
                          choices: [
                            {
                              index: 0,
                              delta: { content: finalContent },
                              finish_reason: null,
                            },
                          ],
                        })}\n\n`
                      )
                    );

                    // Send final chunk with finish_reason
                    const finalChunk: any = {
                      id: requestId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: body.model,
                      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    };

                    if (body.stream_options?.include_usage) {
                      finalChunk.usage = {
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        total_tokens: 0,
                      };
                    }

                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`)
                    );

                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  } else if (
                    event.run &&
                    (event.run.status === "failed" ||
                      event.run.status === "cancelled")
                  ) {
                    const errorContent = `**Error**: Task ${
                      event.run.status
                    } - ${event.run.error?.message || "Unknown error"}`;

                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({
                          id: requestId,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: body.model,
                          choices: [
                            {
                              index: 0,
                              delta: { content: errorContent },
                              finish_reason: "stop",
                            },
                          ],
                        })}\n\n`
                      )
                    );

                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  }
                  break;

                case "error":
                  const errorContent = `**Error**: ${
                    event.error?.message || "Unknown error"
                  }`;

                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        id: requestId,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: body.model,
                        choices: [
                          {
                            index: 0,
                            delta: { content: errorContent },
                            finish_reason: "stop",
                          },
                        ],
                      })}\n\n`
                    )
                  );

                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                  return;

                default:
                  console.log("Unhandled event type:", event.type);
                  break;
              }
            }

            // Fallback close if we exit the loop without explicit completion
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (error) {
            console.error("Stream error:", error);

            const errorContent = `**Error**: ${
              error.message || "Stream processing failed"
            }`;

            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: errorContent },
                        finish_reason: "stop",
                      },
                    ],
                  })}\n\n`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (e) {
              console.error("Error sending error message:", e);
            }

            controller.close();
          }
        },
      });

      return new Response(stream, {
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
