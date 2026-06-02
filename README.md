# teradata-mcp-server

A read-only MCP (Model Context Protocol) server for Teradata. Lets AI agents query your Teradata database safely — no writes, no DDL, no session changes.

## Features

- **Read-only** — only `SELECT` queries allowed
- **Two modes** — stdio (local) or HTTP + JWT (remote)
- **Official driver** — uses Teradata's own `teradatasql` Node.js driver
- **No third-party auth libraries** — JWT verified with Node.js built-in `crypto`
- **Query safety** — blocks dangerous keywords, requires `TOP`, `SAMPLE`, or `WHERE`

## Tools exposed to AI agents

| Tool | Description |
|---|---|
| `list_tables` | List all tables in the current (or specified) database |
| `describe_table` | Show columns and types for a table |
| `query` | Run a read-only SELECT query |

## Installation

Requires Node.js >= 20.

```bash
npm install
cp .env.example .env
# Fill in your Teradata credentials and API_KEY
```

## Usage

### Stdio mode (local agent)

```bash
node server.js
```

Configure in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "teradata": {
      "command": "node",
      "args": ["/path/to/server.js"]
    }
  }
}
```

Test from command line:

```bash
# Windows
echo {"jsonrpc":"2.0","method":"tools/list","params":{},"id":1} | node server.js

# Mac / Linux
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' | node server.js
```

### HTTP mode (remote agent)

```bash
node server.js --http
```

Agents connect via:

```http
POST http://your-server:3000/mcp
Authorization: Bearer <jwt-token>
```

## Testing

Three test JSON files are included. Before running, edit each file and replace `your-api-key` with the value from your `.env`.

**Step 1 — Check server starts and lists tools:**

```cmd
node server.js < test-list-tools.json
```

Expected output: JSON with `query`, `list_tables`, `describe_table`.

**Step 2 — List tables in your database:**

```cmd
node server.js < test-list-tables.json
```

Expected output: JSON array of table names.

**Step 3 — Run a query:**

Edit `test-query.json` and replace `your_table` with a real table name, then:

```cmd
node server.js < test-query.json
```

Expected output: JSON array of rows.

> **Windows tip:** If `<` redirection doesn't work in cmd, use PowerShell:
> ```powershell
> Get-Content test-query.json | node server.js
> ```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TD_HOST` | Yes | Teradata hostname or IP |
| `TD_USER` | Yes | DB username (use a read-only account) |
| `TD_PASSWORD` | Yes | DB password |
| `TD_DATABASE` | No | Default database (optional) |
| `API_KEY` | Yes | Secret key agents must pass in tool calls |
| `HTTP_PORT` | No | HTTP mode port, default: 3000 |
| `JWT_SECRET` | HTTP only | Secret for JWT verification |

## Create a read-only DB user (Teradata)

```sql
CREATE USER mcp_agent AS
  PASSWORD = 'strong-password'
  PERM = 0;

GRANT SELECT ON your_database TO mcp_agent;
```

## Generate API_KEY

```bash
node -e "const c=require('crypto');console.log(c.randomBytes(32).toString('hex'))"
```

## Teradata-specific notes

- Default port is **1025** (handled automatically by the driver)
- `SAMPLE n` is supported as an alternative to `TOP n` for row limiting
- Query safety blocks Teradata-specific dangerous operations: `SEL INTO`, `COLLECT STATS`, `.SET SESSION`, `DATABASE`
