import type { RuntimeMetadata } from '../../../shared/runtime-bootstrap'
import { writeRuntimeMetadata } from '../runtime-metadata'
import type { RpcMessageContext } from '../rpc/transport'
import type { RpcRequest, RpcResponse } from '../rpc/core'
import { errorResponse } from '../rpc/errors'
import { RuntimeRpcBinaryRouting } from './runtime-rpc-binary-routing'
import { classifyRuntimeLongPoll, type RuntimeLongPollClass } from './runtime-rpc-long-poll'
import { httpOriginFromWsEndpoint } from './runtime-rpc-pairing-types'
import { resolveAdvertisedPairingEndpoint } from '../pairing-endpoint'

export class RuntimeRpcRequestAdmission extends RuntimeRpcBinaryRouting {
  // Why: Unix socket dispatch is one-shot and auths via the shared token from the 0o600 metadata file. See §3.1.
  protected async handleMessage(
    rawMessage: string,
    context?: RpcMessageContext
  ): Promise<RpcResponse> {
    // Why: the transport sends an empty message when a client exceeds max size, then closes the connection.
    if (!rawMessage) {
      return this.buildError('unknown', 'request_too_large', 'RPC request exceeds the maximum size')
    }

    const parsed = this.parseAndAuth(rawMessage)
    if ('error' in parsed) {
      return parsed.error
    }
    const request = parsed.request

    // Why: long-poll admission fence; short RPCs bypass the counter. See §7 risk #2.
    const longPoll = classifyRuntimeLongPoll(request)
    const rejection = this.admitLongPoll(longPoll)
    if (rejection) {
      return this.buildError(request.id, 'runtime_busy', rejection)
    }
    if (longPoll) {
      // Why: arm keepalive only for long-polls; short RPCs never create the setInterval. See §3.1.
      context?.startKeepalive()
    }

    try {
      return await this.dispatcher.dispatch(request, {
        signal: longPoll ? context?.signal : undefined,
        // Why: this socket is local trust — the 0o600 metadata file is the credential — so the bundled
        // CLI's `pairing-url` command may mint a runtime pairing offer.
        createRuntimePairingOffer: this.mintRuntimePairingOffer ?? undefined,
        webPreviewHttpOrigin: this.resolveWebPreviewHttpOrigin()
      })
    } finally {
      this.releaseLongPoll(longPoll)
    }
  }

  // Why: one fence for both transports — the total cap protects short RPCs, the ask
  // sub-cap protects terminal.wait / check --wait from slow reply-blocked asks.
  // Returns the rejection message, or null once the slot is reserved.
  protected admitLongPoll(
    longPoll: RuntimeLongPollClass | null,
    pairedDeviceId?: string
  ): string | null {
    if (!longPoll) {
      return null
    }
    if (this.activeLongPolls >= this.longPollCap) {
      return 'long-poll capacity reached; retry with backoff'
    }
    if (
      (longPoll === 'ask' || longPoll === 'browser-host') &&
      this.activeAskLongPolls + this.activeBrowserHostLongPolls >= this.specializedLongPollCap
    ) {
      return longPoll === 'ask'
        ? 'orchestration.ask capacity reached; retry with backoff'
        : 'browser-host capacity reached; retry with backoff'
    }
    if (longPoll === 'ask' && this.activeAskLongPolls >= this.askLongPollCap) {
      return 'orchestration.ask capacity reached; retry with backoff'
    }
    if (
      longPoll === 'browser-host' &&
      (this.activeBrowserHostLongPolls >= this.browserHostLongPollCap ||
        (pairedDeviceId !== undefined &&
          (this.activeBrowserHostLongPollsByDevice.get(pairedDeviceId) ?? 0) >=
            this.browserHostLongPollCapPerDevice))
    ) {
      return 'browser-host capacity reached; retry with backoff'
    }
    this.activeLongPolls += 1
    if (longPoll === 'ask') {
      this.activeAskLongPolls += 1
    } else if (longPoll === 'browser-host') {
      this.activeBrowserHostLongPolls += 1
      if (pairedDeviceId !== undefined) {
        this.activeBrowserHostLongPollsByDevice.set(
          pairedDeviceId,
          (this.activeBrowserHostLongPollsByDevice.get(pairedDeviceId) ?? 0) + 1
        )
      }
    }
    return null
  }

  protected releaseLongPoll(longPoll: RuntimeLongPollClass | null, pairedDeviceId?: string): void {
    if (!longPoll) {
      return
    }
    this.activeLongPolls = Math.max(0, this.activeLongPolls - 1)
    if (longPoll === 'ask') {
      this.activeAskLongPolls = Math.max(0, this.activeAskLongPolls - 1)
    } else if (longPoll === 'browser-host') {
      this.activeBrowserHostLongPolls = Math.max(0, this.activeBrowserHostLongPolls - 1)
      if (pairedDeviceId !== undefined) {
        const remaining = (this.activeBrowserHostLongPollsByDevice.get(pairedDeviceId) ?? 1) - 1
        if (remaining > 0) {
          this.activeBrowserHostLongPollsByDevice.set(pairedDeviceId, remaining)
        } else {
          this.activeBrowserHostLongPollsByDevice.delete(pairedDeviceId)
        }
      }
    }
  }

  protected parseAndAuth(rawMessage: string): { request: RpcRequest } | { error: RpcResponse } {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      return { error: this.buildError('unknown', 'bad_request', 'Invalid JSON request') }
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      return { error: this.buildError('unknown', 'bad_request', 'Missing request id') }
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return { error: this.buildError(request.id, 'bad_request', 'Missing RPC method') }
    }
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      return { error: this.buildError(request.id, 'unauthorized', 'Missing auth token') }
    }
    if (request.authToken !== this.authToken) {
      return { error: this.buildError(request.id, 'unauthorized', 'Invalid auth token') }
    }

    return { request }
  }

  // Why: the webpreview RPC methods run on this same server, but a handler has no live HTTP
  // request to derive its own address from — only the transport layer knows the bound host/port.
  // The raw bind endpoint is not necessarily client-reachable (a wide bind listens on the
  // 0.0.0.0 wildcard, which no client can dial), so this reuses the same wildcard-safe
  // resolution the pairing offer already applies rather than handing back the literal bind host.
  protected resolveWebPreviewHttpOrigin(): string | null {
    const ws = this.transports.find((meta) => meta.kind === 'websocket')
    if (!ws) {
      return null
    }
    const advertised = resolveAdvertisedPairingEndpoint(ws.endpoint, this.defaultPairingAddress)
    return advertised.ok ? httpOriginFromWsEndpoint(advertised.endpoint) : null
  }

  protected buildError(id: string, code: string, message: string): RpcResponse {
    return errorResponse(id, { runtimeId: this.runtime.getRuntimeId() }, code, message)
  }

  protected writeMetadata(): void {
    const metadata: RuntimeMetadata = {
      runtimeId: this.runtime.getRuntimeId(),
      pid: this.pid,
      transports: this.transports,
      authToken: this.authToken,
      startedAt: this.runtime.getStartedAt()
    }
    writeRuntimeMetadata(this.userDataPath, metadata)
  }
}
