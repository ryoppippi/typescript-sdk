import { IncomingMessage, ServerResponse } from "node:http";
import { Transport } from "../shared/transport.js";
import { JSONRPCMessage, JSONRPCMessageSchema, RequestId } from "../types.js";
import getRawBody from "raw-body";
import contentType from "content-type";

const MAXIMUM_MESSAGE_SIZE = "4mb";

/**
 * Configuration options for StreamableHTTPServerTransport
 */
export interface StreamableHTTPServerTransportOptions {
  /**
   * The session ID SHOULD be globally unique and cryptographically secure (e.g., a securely generated UUID, a JWT, or a cryptographic hash)
   * 
   * When sessionId is not set, the transport will be in stateless mode.
   */
  sessionId: string | undefined;

  /**
   * Custom headers to be included in all responses
   * These headers will be added to both SSE and regular HTTP responses
   */
  customHeaders?: Record<string, string>;

}

/**
 * Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It supports both SSE streaming and direct HTTP responses.
 * 
 * Usage example:
 * 
 * ```typescript
 * // Stateful mode - server sets the session ID
 * const statefulTransport = new StreamableHTTPServerTransport({
 *  sessionId: randomUUID(),
 * });
 * 
 * // Stateless mode - explisitly set session ID to undefined
 * const statelessTransport = new StreamableHTTPServerTransport({
 *    sessionId: undefined,
 * });
 * 
 * // Using with pre-parsed request body
 * app.post('/mcp', (req, res) => {
 *   transport.handleRequest(req, res, req.body);
 * });
 * ```
 * 
 * In stateful mode:
 * - Session ID is generated and included in response headers
 * - Session ID is always included in initialization responses
 * - Requests with invalid session IDs are rejected with 404 Not Found
 * - Non-initialization requests without a session ID are rejected with 400 Bad Request
 * - State is maintained in-memory (connections, message history)
 * 
 * In stateless mode:
 * - Session ID is only included in initialization responses
 * - No session validation is performed
 */
export class StreamableHTTPServerTransport implements Transport {
  // when sessionID is not set, it means the transport is in stateless mode
  private _sessionId: string | undefined;
  private _started: boolean = false;
  private _customHeaders: Record<string, string>;
  private _sseResponseMapping: Map<RequestId, ServerResponse> = new Map();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options: StreamableHTTPServerTransportOptions) {
    this._sessionId = options?.sessionId;
    this._customHeaders = options?.customHeaders || {};
  }

  /**
   * Starts the transport. This is required by the Transport interface but is a no-op
   * for the Streamable HTTP transport as connections are managed per-request.
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  /**
   * Handles an incoming HTTP request, whether GET or POST
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    // Only validate session ID for non-initialization requests when session management is enabled
    if (this._sessionId !== undefined) {
      const isInitializationRequest = req.method === "POST" &&
        req.headers["content-type"]?.includes("application/json");

      if (!isInitializationRequest && !this.validateSession(req, res)) {
        return;
      }
    }

    if (req.method === "GET") {
      await this.handleGetRequest(req, res);
    } else if (req.method === "POST") {
      await this.handlePostRequest(req, res, parsedBody);
    } else if (req.method === "DELETE") {
      await this.handleDeleteRequest(req, res);
    } else {
      res.writeHead(405, this._customHeaders).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed"
        },
        id: null
      }));
    }
  }

  /**
   * Handles GET requests to establish SSE connections
   * According to the MCP Streamable HTTP transport spec, the server MUST either return SSE or 405.
   * We choose to return 405 Method Not Allowed as we don't support GET SSE connections yet.
   */
  private async handleGetRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Return 405 Method Not Allowed
    res.writeHead(405, {
      ...this._customHeaders,
      "Allow": "POST, DELETE"
    }).end(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed: Server does not offer an SSE stream at this endpoint"
      },
      id: null
    }));
  }

  /**
   * Handles POST requests containing JSON-RPC messages
   */
  private async handlePostRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    try {
      // validate the Accept header
      const acceptHeader = req.headers.accept;
      if (!acceptHeader ||
        (!acceptHeader.includes("application/json") && !acceptHeader.includes("text/event-stream"))) {
        res.writeHead(406).end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Not Acceptable: Client must accept application/json and/or text/event-stream"
          },
          id: null
        }));
        return;
      }

      const ct = req.headers["content-type"];
      if (!ct || !ct.includes("application/json")) {
        res.writeHead(415).end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Unsupported Media Type: Content-Type must be application/json"
          },
          id: null
        }));
        return;
      }

      let rawMessage;
      if (parsedBody !== undefined) {
        rawMessage = parsedBody;
      } else {
        const parsedCt = contentType.parse(ct);
        const body = await getRawBody(req, {
          limit: MAXIMUM_MESSAGE_SIZE,
          encoding: parsedCt.parameters.charset ?? "utf-8",
        });
        rawMessage = JSON.parse(body.toString());
      }

      let messages: JSONRPCMessage[];

      // handle batch and single messages
      if (Array.isArray(rawMessage)) {
        messages = rawMessage.map(msg => JSONRPCMessageSchema.parse(msg));
      } else {
        messages = [JSONRPCMessageSchema.parse(rawMessage)];
      }

      if (this._sessionId !== undefined) {
        // Check if this is an initialization request
        // https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle/
        const isInitializationRequest = messages.some(
          msg => 'method' in msg && msg.method === 'initialize' && 'id' in msg
        );

        if (!isInitializationRequest && !this.validateSession(req, res)) {
          return;
        }
      }


      // check if it contains requests
      const hasRequests = messages.some(msg => 'method' in msg && 'id' in msg);
      const hasOnlyNotificationsOrResponses = messages.every(msg =>
        ('method' in msg && !('id' in msg)) || ('result' in msg || 'error' in msg));

      if (hasOnlyNotificationsOrResponses) {
        // if it only contains notifications or responses, return 202
        res.writeHead(202).end();

        // handle each message
        for (const message of messages) {
          this.onmessage?.(message);
        }
      } else if (hasRequests) {
        // if it contains requests, you can choose to return an SSE stream or a JSON response
        const useSSE = acceptHeader.includes("text/event-stream");

        if (useSSE) {
          const headers: Record<string, string> = {
            ...this._customHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          };

          // For initialization requests, always include the session ID if we have one
          // even if we're in stateless mode
          if (this._sessionId !== undefined) {
            headers["mcp-session-id"] = this._sessionId;
          }

          res.writeHead(200, headers);

          // Store the response for this request to send messages back through this connection
          // We need to track by request ID to maintain the connection
          for (const message of messages) {
            if ('method' in message && 'id' in message) {
              this._sseResponseMapping.set(message.id, res);
            }
          }

          // handle each message
          for (const message of messages) {
            this.onmessage?.(message);
          }

          // The server SHOULD NOT close the SSE stream before sending all JSON-RPC responses
          // This will be handled by the send() method when responses are ready
        } else {
          // use direct JSON response
          const headers: Record<string, string> = {
            ...this._customHeaders,
            "Content-Type": "application/json",
          };

          // For initialization requests, always include the session ID if we have one
          // even if we're in stateless mode
          if (this._sessionId !== undefined) {
            headers["mcp-session-id"] = this._sessionId;
          }

          res.writeHead(200, headers);

          // handle each message
          for (const message of messages) {
            this.onmessage?.(message);
          }

          res.end();
        }
      }
    } catch (error) {
      // return JSON-RPC formatted error
      res.writeHead(400).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "Parse error",
          data: String(error)
        },
        id: null
      }));
      this.onerror?.(error as Error);
    }
  }

  /**
   * Handles DELETE requests to terminate sessions
   */
  private async handleDeleteRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.close();
    res.writeHead(200).end();
  }

  /**
   * Validates session ID for non-initialization requests when session management is enabled
   * Returns true if the session is valid, false otherwise
   */
  private validateSession(req: IncomingMessage, res: ServerResponse): boolean {
    const sessionId = req.headers["mcp-session-id"];

    if (!sessionId) {
      // Non-initialization requests without a session ID should return 400 Bad Request
      res.writeHead(400, this._customHeaders).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: Mcp-Session-Id header is required"
        },
        id: null
      }));
      return false;
    } else if ((Array.isArray(sessionId) ? sessionId[0] : sessionId) !== this._sessionId) {
      // Reject requests with invalid session ID with 404 Not Found
      res.writeHead(404, this._customHeaders).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Session not found"
        },
        id: null
      }));
      return false;
    }

    return true;
  }


  async close(): Promise<void> {
    // Close all SSE connections
    this._sseResponseMapping.forEach((response) => {
      response.end();
    });
    this._sseResponseMapping.clear();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void> {
    const relatedRequestId = options?.relatedRequestId;
    if (relatedRequestId === undefined) {
      throw new Error("relatedRequestId is required");
    }

    const sseResponse = this._sseResponseMapping.get(relatedRequestId);
    if (!sseResponse) {
      throw new Error("No SSE connection established");
    }

    // Send the message as an SSE event
    sseResponse.write(
      `event: message\ndata: ${JSON.stringify(message)}\n\n`,
    );

    // If this is a response message with the same ID as the request, we can check
    // if we need to close the stream after sending the response
    if ('result' in message || 'error' in message) {
      if (message.id === relatedRequestId) {
        // This is a response to the original request, we can close the stream
        // after sending all related responses
        this._sseResponseMapping.delete(relatedRequestId);
        sseResponse.end();
      }
    }
  }

  /**
   * Returns the session ID for this transport
   */
  get sessionId(): string | undefined {
    return this._sessionId;
  }
} 