import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import {
  PairingGetEndpointsParamsSchema,
  PairingProvisionRelayParamsSchema
} from '../../../../shared/mobile-relay-credential-contract'
import { RUNTIME_PAIRING_REACHES } from '../../../../shared/runtime-pairing-reach'

const CreateRuntimeOfferParamsSchema = z.object({
  address: z.string().nullish(),
  rotate: z.boolean().optional(),
  // Why: STA-2370 — "This computer only" must survive the hop from a browser client, which reaches this
  // method instead of the desktop-only `mobile:getRuntimePairingUrl` IPC. Omitted means network reach.
  reach: z.enum(RUNTIME_PAIRING_REACHES).optional()
})

export const PAIRING_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'pairing.createRuntimeOffer',
    params: CreateRuntimeOfferParamsSchema,
    handler: (params, ctx) => {
      // Why: the offer is a runtime-scope credential, so only the transports that already
      // authenticated one provide the minter (local Unix socket, runtime-scope WebSocket devices).
      // Mobile-scope devices are refused twice — here, and by the mobile method allowlist.
      if (!ctx.createRuntimePairingOffer) {
        throw new Error('pairing_offer_unavailable')
      }
      return ctx.createRuntimePairingOffer({
        address: params.address ?? null,
        rotate: params.rotate ?? false,
        ...(params.reach ? { reach: params.reach } : {})
      })
    }
  }),
  defineMethod({
    name: 'pairing.getEndpoints',
    params: PairingGetEndpointsParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.getEndpoints(params)
    }
  }),
  defineMethod({
    name: 'pairing.provisionRelay',
    params: PairingProvisionRelayParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.provisionRelay(params)
    }
  })
]
