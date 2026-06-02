#!/usr/bin/env node
import 'dotenv/config'
import { createRequire } from 'module'
import http from 'http'
import { createHmac } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const require = createRequire(import.meta.url)
const { TeradataConnection } = require('teradatasql')

const API_KEY   = process.env.API_KEY
const JWT_SECRET = process.env.JWT_SECRET
const HTTP_PORT  = Number(process.env.HTTP_PORT) || 3000
const USE_HTTP   = process.argv.includes('--http')

if (!API_KEY) { console.error('ERROR: API_KEY not set in .env'); process.exit(1) }
if (USE_HTTP && !JWT_SECRET) { console.error('ERROR: JWT_SECRET not set in .env'); process.exit(1) }

const connParams = JSON.stringify({
  host:     process.env.TD_HOST,
  user:     process.env.TD_USER,
  password: process.env.TD_PASSWORD,
  ...(process.env.TD_DATABASE ? { database: process.env.TD_DATABASE } : {}),
})

// ── DB helper ─────────────────────────────────────────────
function runQuery(sql) {
  return new Promise((resolve, reject) => {
    let conn, cursor
    try {
      conn   = new TeradataConnection()
      conn.connect(connParams)
      cursor = conn.cursor()
      cursor.execute(sql)
      const cols = cursor.description.map(d => d[0])
      const rows = cursor.fetchall().map(row =>
        Object.fromEntries(cols.map((c, i) => [c, row[i]]))
      )
      resolve(rows)
    } catch (err) {
      reject(err)
    } finally {
      try { cursor?.close() } catch (_) {}
      try { conn?.close()   } catch (_) {}
    }
  })
}
// ─────────────────────────────────────────────────────────

// ── 安全驗證 ──────────────────────────────────────────────
function validateQuery(query) {
  const normalized = query.trim().toLowerCase()

  if (!normalized.startsWith('select')) {
    return { ok: false, reason: 'Only SELECT queries are allowed' }
  }

  const blocked = [
    'insert', 'update', 'delete', 'drop', 'truncate', 'alter', 'create',
    'exec', 'execute',
    'sel into', 'collect stats',  // Teradata 特有的危險操作
    '.set session', 'database ',  // 切換 database / session 設定
    ';',
  ]
  for (const keyword of blocked) {
    if (normalized.includes(keyword)) {
      return { ok: false, reason: `Blocked keyword: ${keyword}` }
    }
  }

  if (!normalized.includes('top ') && !normalized.includes('where') && !normalized.includes('sample ')) {
    return { ok: false, reason: 'Query must include TOP, SAMPLE, or WHERE to limit result size' }
  }

  return { ok: true }
}
// ─────────────────────────────────────────────────────────

// ── JWT 驗證（HTTP 模式用）────────────────────────────────
function verifyJwt(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return false
  const token = authHeader.slice(7)
  const [headerB64, payloadB64, sig] = token.split('.')
  if (!headerB64 || !payloadB64 || !sig) return false
  const expected = createHmac('sha256', JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url')
  if (sig !== expected) return false
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return false
  return true
}
// ─────────────────────────────────────────────────────────

const server = new McpServer({ name: 'teradata-readonly', version: '1.0.0' })

server.tool(
  'query',
  'Run a read-only SQL SELECT query against Teradata',
  {
    sql:     z.string().describe('The SELECT query to execute'),
    api_key: z.string().describe('API key for authentication'),
  },
  async ({ sql: queryStr, api_key }) => {
    if (api_key !== API_KEY) {
      return { content: [{ type: 'text', text: 'Error: Invalid API key' }], isError: true }
    }
    const check = validateQuery(queryStr)
    if (!check.ok) {
      return { content: [{ type: 'text', text: `Error: ${check.reason}` }], isError: true }
    }
    try {
      const rows = await runQuery(queryStr)
      console.error(`[query] rows=${rows.length} sql="${queryStr.slice(0, 80)}"`)
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
    } catch (err) {
      console.error(`[query error] ${err.message}`)
      return { content: [{ type: 'text', text: `DB Error: ${err.message}` }], isError: true }
    }
  }
)

server.tool(
  'list_tables',
  'List all tables in the current database',
  { api_key: z.string(), database: z.string().optional().describe('Database name (optional)') },
  async ({ api_key, database }) => {
    if (api_key !== API_KEY) {
      return { content: [{ type: 'text', text: 'Error: Invalid API key' }], isError: true }
    }
    const dbFilter = database
      ? `WHERE DatabaseName = '${database.replace(/'/g, '')}'`
      : `WHERE DatabaseName = DATABASE`
    try {
      const rows = await runQuery(
        `SELECT DatabaseName, TableName, TableKind FROM DBC.TablesV ${dbFilter} ORDER BY TableName`
      )
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `DB Error: ${err.message}` }], isError: true }
    }
  }
)

server.tool(
  'describe_table',
  'Show columns and types for a specific Teradata table',
  { table: z.string(), database: z.string().optional(), api_key: z.string() },
  async ({ table, database, api_key }) => {
    if (api_key !== API_KEY) {
      return { content: [{ type: 'text', text: 'Error: Invalid API key' }], isError: true }
    }
    if (!/^[\w]+$/.test(table)) {
      return { content: [{ type: 'text', text: 'Error: Invalid table name' }], isError: true }
    }
    const dbFilter = database
      ? `AND DatabaseName = '${database.replace(/'/g, '')}'`
      : ''
    try {
      const rows = await runQuery(
        `SELECT ColumnName, ColumnType, Nullable, DefaultValue
         FROM DBC.ColumnsV WHERE TableName = '${table}' ${dbFilter}
         ORDER BY ColumnId`
      )
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `DB Error: ${err.message}` }], isError: true }
    }
  }
)

if (USE_HTTP) {
  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      if (!verifyJwt(req.headers['authorization'])) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  httpServer.listen(HTTP_PORT, () => {
    console.error(`[teradata-mcp] HTTP mode, listening on port ${HTTP_PORT}`)
  })
} else {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[teradata-mcp] Stdio mode, waiting for connections...')
}
