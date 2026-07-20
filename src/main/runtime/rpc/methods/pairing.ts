import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import {
  PairingGetEndpointsParamsSchema,
  PairingProvisionRelayParamsSchema
} from '../../../../shared/mobile-relay-credential-contract'

const CreateRuntimeOfferParamsSchema = z.object({
  address: z.string().nullish(),
  rotate: z.boolean().optional()
})

export const PAIRING_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'pairing.createRuntimeOffer',
    params: CreateRuntimeOfferParamsSchema,
    handler: (params, ctx) => {
      // Why: only exposed on the local unix socket and runtime-scope WS clients
      // (see runtime-rpc.ts); mobile devices never receive this capability.
      if (!ctx.createRuntimePairingOffer) {
        throw new Error('pairing_offer_unavailable')
      }
      return ctx.createRuntimePairingOffer({
        address: params.address ?? null,
        rotate: params.rotate ?? false
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
