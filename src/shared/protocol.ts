/**
 * JSON-RPC 2.0 protocol types for Bond daemon ↔ client communication.
 *
 * Three message patterns over a single WebSocket:
 * 1. Request/response — client sends JsonRpcRequest, daemon replies with JsonRpcResponse
 * 2. Notification (no id) — daemon pushes events (e.g. bond.chunk) to clients
 * 3. Tool approval — daemon pushes tool_approval chunk, client responds via bond.approvalResponse
 */

// --- JSON-RPC base types ---

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

// --- Error codes ---

export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603

// --- Helpers ---

export function makeRequest(id: string | number, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params }
}

export function makeResponse(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function makeErrorResponse(id: string | number, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

export function makeNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params }
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'id' in msg && 'method' in msg
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && !('method' in msg)
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return !('id' in msg) && 'method' in msg
}
