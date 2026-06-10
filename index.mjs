import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const client = new CloudWatchLogsClient({
  region: process.env.AWS_REGION || "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
});

const server = new Server(
  { name: "cloudwatch-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_log_groups",
      description: "List all CloudWatch log groups",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "search_errors",
      description: "Search for errors/bugs in a log group (last N minutes)",
      inputSchema: {
        type: "object",
        required: ["logGroupName"],
        properties: {
          logGroupName: { type: "string", description: "CloudWatch log group name" },
          minutes: { type: "number", description: "Last N minutes to search (default: 60)" },
          filterPattern: { type: "string", description: "Filter pattern e.g. ERROR, Exception, FATAL" },
        },
      },
    },
    {
      name: "analyze_bug_report",
      description: "Deep analysis of a specific error — frequency, first/last occurrence, sample logs",
      inputSchema: {
        type: "object",
        required: ["logGroupName", "errorKeyword"],
        properties: {
          logGroupName: { type: "string" },
          errorKeyword: { type: "string", description: "Keyword to search e.g. NullPointerException" },
          minutes: { type: "number", description: "Time range in minutes (default: 120)" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_log_groups") {
    const res = await client.send(new DescribeLogGroupsCommand({ limit: 50 }));
    const groups = res.logGroups?.map((g) => g.logGroupName) || [];
    return {
      content: [{ type: "text", text: `Log Groups (${groups.length}):\n` + groups.join("\n") }],
    };
  }

  if (name === "search_errors") {
    const minutes = args?.minutes || 60;
    const startTime = Date.now() - minutes * 60 * 1000;
    const pattern = args?.filterPattern || "ERROR";

    const res = await client.send(
      new FilterLogEventsCommand({
        logGroupName: args.logGroupName,
        startTime,
        filterPattern: pattern,
        limit: 50,
      })
    );

    const events = res.events?.map((e) => ({
      time: new Date(e.timestamp).toISOString(),
      message: e.message?.trim(),
    })) || [];

    if (events.length === 0) {
      return { content: [{ type: "text", text: `No "${pattern}" found in last ${minutes} minutes.` }] };
    }

    return {
      content: [{
        type: "text",
        text: `Found ${events.length} events for "${pattern}" in last ${minutes} min:\n\n` +
          events.map((e) => `[${e.time}] ${e.message}`).join("\n"),
      }],
    };
  }

  if (name === "analyze_bug_report") {
    const minutes = args?.minutes || 120;
    const startTime = Date.now() - minutes * 60 * 1000;
    const keyword = args.errorKeyword;

    const res = await client.send(
      new FilterLogEventsCommand({
        logGroupName: args.logGroupName,
        startTime,
        filterPattern: keyword,
        limit: 100,
      })
    );

    const events = res.events || [];

    if (events.length === 0) {
      return { content: [{ type: "text", text: `No logs found for keyword: "${keyword}"` }] };
    }

    const firstOccurrence = new Date(events[0].timestamp).toISOString();
    const lastOccurrence = new Date(events[events.length - 1].timestamp).toISOString();
    const sampleLogs = events.slice(0, 5).map((e) => `[${new Date(e.timestamp).toISOString()}] ${e.message?.trim()}`);

    const report = [
      `Bug Report: "${keyword}"`,
      `Total Occurrences: ${events.length} (last ${minutes} min)`,
      `First Seen: ${firstOccurrence}`,
      `Last Seen:  ${lastOccurrence}`,
      ``,
      `Sample Logs:`,
      ...sampleLogs,
    ].join("\n");

    return { content: [{ type: "text", text: report }] };
  }

  return { content: [{ type: "text", text: "Unknown tool" }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
