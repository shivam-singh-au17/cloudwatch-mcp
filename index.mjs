import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

// ---------------------------------------------------------------------------
// Client management (per-region, cached). Region can be overridden per call so
// we can target eu-west-2 (prod) regardless of the process env default.
// ---------------------------------------------------------------------------
const DEFAULT_REGION = process.env.AWS_REGION || "eu-west-2";

const envCreds = process.env.AWS_ACCESS_KEY_ID
  ? {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    }
  : undefined; // fall back to the default AWS credential chain

const clientCache = new Map();
function clientFor(region) {
  const r = region || DEFAULT_REGION;
  if (!clientCache.has(r)) {
    clientCache.set(r, new CloudWatchLogsClient({ region: r, credentials: envCreds }));
  }
  return clientCache.get(r);
}

// ---------------------------------------------------------------------------
// Time helpers — accept ISO-8601 strings, epoch-ms numbers, or numeric strings.
// ---------------------------------------------------------------------------
function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (/^\d+$/.test(v)) return Number(v); // epoch ms as string
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Invalid time value: "${v}" (use ISO-8601 like 2026-06-08T02:55:00Z or epoch ms)`);
  return t;
}

// Resolve a [start, end] window in epoch-ms from absolute or relative inputs.
function resolveWindow({ startTime, endTime, minutes }) {
  const end = endTime != null ? toMs(endTime) : Date.now();
  const start = startTime != null ? toMs(startTime) : end - (minutes || 60) * 60_000;
  if (start >= end) throw new Error(`startTime (${new Date(start).toISOString()}) must be before endTime (${new Date(end).toISOString()})`);
  return { start, end };
}

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Core fetchers
// ---------------------------------------------------------------------------
async function listGroups(c, { namePrefix, max = 200 } = {}) {
  const out = [];
  let nextToken;
  do {
    const res = await c.send(
      new DescribeLogGroupsCommand({
        ...(namePrefix ? { logGroupNamePrefix: namePrefix } : {}),
        nextToken,
        limit: 50,
      }),
    );
    for (const g of res.logGroups || []) out.push(g.logGroupName);
    nextToken = res.nextToken;
  } while (nextToken && out.length < max);
  return out;
}

// Page through FilterLogEvents up to `max` events, then sort chronologically.
async function fetchEvents(c, { logGroupName, start, end, filterPattern, logStreamNamePrefix, max = 1000 }) {
  const events = [];
  let nextToken;
  do {
    const res = await c.send(
      new FilterLogEventsCommand({
        logGroupName,
        startTime: start,
        endTime: end,
        ...(filterPattern ? { filterPattern } : {}),
        ...(logStreamNamePrefix ? { logStreamNamePrefixes: [logStreamNamePrefix] } : {}),
        nextToken,
        limit: 1000,
      }),
    );
    for (const e of res.events || []) events.push(e);
    nextToken = res.nextToken;
  } while (nextToken && events.length < max);

  events.sort((a, b) => a.timestamp - b.timestamp); // FilterLogEvents does NOT guarantee order across streams
  return { events: events.slice(0, max), truncated: Boolean(nextToken) };
}

// Run a CloudWatch Logs Insights query and wait for completion.
async function runInsights(c, { groups, queryString, start, end, limit = 1000 }) {
  const sq = await c.send(
    new StartQueryCommand({
      logGroupNames: groups,
      startTime: Math.floor(start / 1000), // Insights wants epoch SECONDS
      endTime: Math.floor(end / 1000),
      queryString,
      limit,
    }),
  );
  const queryId = sq.queryId;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const r = await c.send(new GetQueryResultsCommand({ queryId }));
    if (r.status === "Complete") return r;
    if (["Failed", "Cancelled", "Timeout"].includes(r.status)) {
      throw new Error(`Insights query ${r.status}`);
    }
  }
  throw new Error("Insights query timed out client-side after 90s");
}

const text = (t) => ({ content: [{ type: "text", text: t }] });

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TIME_PROPS = {
  startTime: { type: "string", description: "Window start — ISO-8601 (e.g. 2026-06-08T02:55:00Z) or epoch ms. Overrides `minutes`." },
  endTime: { type: "string", description: "Window end — ISO-8601 or epoch ms. Defaults to now." },
  minutes: { type: "number", description: "Relative fallback: last N minutes (used only if startTime is omitted). Default 60." },
  region: { type: "string", description: "AWS region override (default eu-west-2)." },
};

const TOOLS = [
  {
    name: "get_log_groups",
    description: "List CloudWatch log groups, with optional name prefix and full pagination (no 50 cap).",
    inputSchema: {
      type: "object",
      properties: {
        namePrefix: { type: "string", description: "Only groups starting with this prefix, e.g. 'ecs/' or 'ecs/players'." },
        max: { type: "number", description: "Max groups to return (default 200)." },
        region: TIME_PROPS.region,
      },
    },
  },
  {
    name: "get_logs",
    description:
      "Fetch raw log events in an absolute or relative time window. Optional filterPattern; if omitted, returns ALL events (use this to prove a log line is ABSENT). Returns timestamp + logStreamName (instance) + message, sorted chronologically, paginated. For multi-word phrases use a quoted filterPattern, e.g. '\"Starting new weekly leaderboards V2\"'.",
    inputSchema: {
      type: "object",
      required: ["logGroupName"],
      properties: {
        logGroupName: { type: "string", description: "e.g. ecs/players" },
        filterPattern: { type: "string", description: "Optional CloudWatch filter pattern. Omit to fetch everything in the window." },
        logStreamNamePrefix: { type: "string", description: "Restrict to one instance/stream prefix, e.g. ecs/players/4ee1401c…" },
        max: { type: "number", description: "Max events to return (default 1000)." },
        ...TIME_PROPS,
      },
    },
  },
  {
    name: "search_errors",
    description: "Search a log group for a pattern (default ERROR) in an absolute or relative window. Returns timestamp + instance + message.",
    inputSchema: {
      type: "object",
      required: ["logGroupName"],
      properties: {
        logGroupName: { type: "string" },
        filterPattern: { type: "string", description: "Default 'ERROR'." },
        ...TIME_PROPS,
      },
    },
  },
  {
    name: "analyze_bug_report",
    description: "Deep analysis of a keyword — total count, first/last occurrence (correctly sorted), per-instance breakdown, and sample logs.",
    inputSchema: {
      type: "object",
      required: ["logGroupName", "errorKeyword"],
      properties: {
        logGroupName: { type: "string" },
        errorKeyword: { type: "string", description: "Keyword / quoted phrase to search." },
        ...TIME_PROPS,
        minutes: { type: "number", description: "Relative fallback (default 120) if startTime omitted." },
      },
    },
  },
  {
    name: "run_insights_query",
    description:
      "Run a CloudWatch Logs Insights query over one or more log groups (best for counting/aggregation — e.g. count occurrences, distinct instances). Provide either logGroupName or logGroupNames.",
    inputSchema: {
      type: "object",
      required: ["queryString"],
      properties: {
        logGroupName: { type: "string" },
        logGroupNames: { type: "array", items: { type: "string" }, description: "Multiple groups to query together." },
        queryString: { type: "string", description: "Insights query, e.g. `fields @timestamp, @logStream, @message | filter @message like /RESET_LEAGUE_CYCLE/ | sort @timestamp asc`." },
        limit: { type: "number", description: "Max result rows (default 1000)." },
        ...TIME_PROPS,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------
const server = new Server({ name: "cloudwatch-mcp", version: "2.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function formatEvents(events) {
  return events
    .map((e) => `[${iso(e.timestamp)}] (${e.logStreamName || "?"}) ${e.message?.trim()}`)
    .join("\n");
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const c = clientFor(args.region);

    if (name === "get_log_groups") {
      const groups = await listGroups(c, { namePrefix: args.namePrefix, max: args.max });
      return text(`Log Groups (${groups.length})${args.namePrefix ? ` matching "${args.namePrefix}"` : ""}:\n` + groups.join("\n"));
    }

    if (name === "get_logs") {
      const { start, end } = resolveWindow(args);
      const { events, truncated } = await fetchEvents(c, {
        logGroupName: args.logGroupName,
        start,
        end,
        filterPattern: args.filterPattern,
        logStreamNamePrefix: args.logStreamNamePrefix,
        max: args.max || 1000,
      });
      const header =
        `Window ${iso(start)} → ${iso(end)} | group ${args.logGroupName}` +
        `${args.filterPattern ? ` | filter ${args.filterPattern}` : " | filter (none)"}` +
        `\nReturned ${events.length} event(s)${truncated ? " (TRUNCATED — increase max or narrow window)" : ""}.`;
      if (events.length === 0) {
        return text(header + "\n\n(no events — if you expected some, this ABSENCE is itself a finding)");
      }
      return text(header + "\n\n" + formatEvents(events));
    }

    if (name === "search_errors") {
      const { start, end } = resolveWindow(args);
      const pattern = args.filterPattern || "ERROR";
      const { events, truncated } = await fetchEvents(c, { logGroupName: args.logGroupName, start, end, filterPattern: pattern, max: 500 });
      if (events.length === 0) return text(`No "${pattern}" in ${iso(start)} → ${iso(end)}.`);
      return text(
        `Found ${events.length}${truncated ? "+" : ""} event(s) for "${pattern}" in ${iso(start)} → ${iso(end)}:\n\n` +
          formatEvents(events),
      );
    }

    if (name === "analyze_bug_report") {
      const { start, end } = resolveWindow({ ...args, minutes: args.minutes || 120 });
      const keyword = args.errorKeyword;
      const { events, truncated } = await fetchEvents(c, { logGroupName: args.logGroupName, start, end, filterPattern: keyword, max: 2000 });
      if (events.length === 0) return text(`No logs for keyword "${keyword}" in ${iso(start)} → ${iso(end)}.`);

      const byStream = {};
      for (const e of events) byStream[e.logStreamName || "?"] = (byStream[e.logStreamName || "?"] || 0) + 1;
      const sample = events.slice(0, 8).map((e) => `[${iso(e.timestamp)}] (${e.logStreamName || "?"}) ${e.message?.trim()}`);

      return text(
        [
          `Bug Report: "${keyword}"`,
          `Window: ${iso(start)} → ${iso(end)}`,
          `Total occurrences: ${events.length}${truncated ? "+ (truncated)" : ""}`,
          `First seen: ${iso(events[0].timestamp)}`,
          `Last seen:  ${iso(events[events.length - 1].timestamp)}`,
          `Distinct instances (streams): ${Object.keys(byStream).length}`,
          ...Object.entries(byStream).map(([s, n]) => `   • ${s}: ${n}`),
          ``,
          `Sample logs:`,
          ...sample,
        ].join("\n"),
      );
    }

    if (name === "run_insights_query") {
      const { start, end } = resolveWindow(args);
      const groups = args.logGroupNames || (args.logGroupName ? [args.logGroupName] : []);
      if (groups.length === 0) throw new Error("Provide logGroupName or logGroupNames");
      const r = await runInsights(c, { groups, queryString: args.queryString, start, end, limit: args.limit });
      const rows = r.results || [];
      const stats = r.statistics ? ` | scanned ${r.statistics.recordsScanned} records` : "";
      if (rows.length === 0) return text(`Insights query complete — 0 rows. Window ${iso(start)} → ${iso(end)}${stats}`);
      const lines = rows.map((row) => row.filter((f) => f.field !== "@ptr").map((f) => `${f.field}=${f.value}`).join("  |  "));
      return text(`Insights: ${rows.length} row(s). Window ${iso(start)} → ${iso(end)}${stats}\n\n` + lines.join("\n"));
    }

    return text(`Unknown tool: ${name}`);
  } catch (err) {
    return text(`ERROR calling ${name}: ${err.name || "Error"}: ${err.message}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
