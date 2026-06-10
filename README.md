# CloudWatch MCP Server

A Model Context Protocol (MCP) server that provides AI assistants (Claude, Cursor, VS Code MCP Clients, etc.) with read-only access to AWS CloudWatch Logs for production debugging and log analysis.

## Overview

This MCP server enables AI agents to inspect CloudWatch logs, identify errors, analyze recurring issues, and generate bug reports without requiring direct AWS Console access.

It is designed for teams that provide developers or AI assistants with read-only CloudWatch permissions while maintaining production security.

### Key Features

* List available CloudWatch Log Groups
* Search application errors and exceptions
* Analyze recurring production issues
* Generate bug reports from log data
* Read-only CloudWatch access
* Compatible with MCP clients such as Claude Desktop, Cursor, VS Code MCP Extensions, and other MCP-compatible tools

---

## Available Tools

### 1. get_log_groups

Returns available CloudWatch Log Groups.

#### Example Use Cases

* Discover application log groups
* Verify deployment log locations
* Explore available environments

---

### 2. search_errors

Searches CloudWatch logs for errors within a specified time range.

#### Parameters

| Parameter     | Type   | Required | Description                     |
| ------------- | ------ | -------- | ------------------------------- |
| logGroupName  | string | Yes      | CloudWatch Log Group            |
| minutes       | number | No       | Lookback window (default: 60)   |
| filterPattern | string | No       | Search pattern (default: ERROR) |

#### Example Queries

* Find ERROR logs in the last hour
* Search for Exceptions in production
* Identify FATAL application failures

---

### 3. analyze_bug_report

Performs deeper analysis on a specific error pattern.

#### Parameters

| Parameter    | Type   | Required | Description                    |
| ------------ | ------ | -------- | ------------------------------ |
| logGroupName | string | Yes      | CloudWatch Log Group           |
| errorKeyword | string | Yes      | Error keyword to search        |
| minutes      | number | No       | Lookback window (default: 120) |

#### Analysis Includes

* Total occurrences
* First occurrence
* Last occurrence
* Sample log entries
* Error frequency overview

#### Example Queries

* Analyze NullPointerException
* Investigate DatabaseTimeout
* Review Redis connection failures

---

## Installation

```bash
git clone https://github.com/your-org/cloudwatch-mcp.git

cd cloudwatch-mcp

npm install
```

> No build step required. The server runs directly using Node.js ES modules (`index.mjs`).

---

## Configuration

Set the following environment variables:

```bash
AWS_REGION=ap-south-1

AWS_ACCESS_KEY_ID=YOUR_ACCESS_KEY

AWS_SECRET_ACCESS_KEY=YOUR_SECRET_KEY

# Required when using temporary/SSO credentials (ASIA... keys)
AWS_SESSION_TOKEN=YOUR_SESSION_TOKEN
```

> `AWS_SESSION_TOKEN` is required when using AWS SSO or temporary credentials (access keys starting with `ASIA`). It is not needed for permanent IAM user credentials (keys starting with `AKIA`).

---

## Example MCP Configuration

Add the following to your `.claude.json` or MCP client config:

**macOS / Linux**
```json
{
  "mcpServers": {
    "cloudwatch-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/cloudwatch-mcp/index.mjs"],
      "env": {
        "AWS_REGION": "ap-south-1",
        "AWS_ACCESS_KEY_ID": "YOUR_ACCESS_KEY",
        "AWS_SECRET_ACCESS_KEY": "YOUR_SECRET_KEY",
        "AWS_SESSION_TOKEN": "YOUR_SESSION_TOKEN"
      }
    }
  }
}
```

**Windows**
```json
{
  "mcpServers": {
    "cloudwatch-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\YourUser\\mcp-servers\\cloudwatch-mcp\\index.mjs"],
      "env": {
        "AWS_REGION": "eu-west-2",
        "AWS_ACCESS_KEY_ID": "YOUR_ACCESS_KEY",
        "AWS_SECRET_ACCESS_KEY": "YOUR_SECRET_KEY",
        "AWS_SESSION_TOKEN": "YOUR_SESSION_TOKEN"
      }
    }
  }
}
```

> **Note:** SSO/temporary credentials expire every ~1 hour. Update all three credential values (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) together and restart your MCP client when they expire.

---

## Required AWS Permissions

This MCP is designed to work with read-only CloudWatch access.

Example IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:DescribeLogGroups",
        "logs:FilterLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## Security

This server only performs read operations.

Supported actions:

* Describe CloudWatch Log Groups
* Read CloudWatch Log Events

Not supported:

* Creating log groups
* Modifying logs
* Deleting logs
* Updating AWS resources
* Any write operations

---

## Example Workflow

1. AI lists available log groups.
2. User selects a log group.
3. AI searches for recent ERROR logs.
4. AI identifies recurring exceptions.
5. AI generates a bug report with timestamps and sample logs.
6. Developer investigates the root cause.

---

## Typical Use Cases

* Production debugging
* Incident investigation
* Error monitoring
* Application health checks
* Root cause analysis
* AI-assisted troubleshooting
* DevOps support

---

## License

MIT License
