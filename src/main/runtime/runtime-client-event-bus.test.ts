import { describe, expect, it, vi } from 'vitest'
import { RuntimeClientEventBus } from './runtime-client-event-bus'

function createBus(): RuntimeClientEventBus {
  return new RuntimeClientEventBus({
    makeTitleGateKey: (rawTitle, normalizedTitle) => `${rawTitle}|${normalizedTitle}`,
    onConsumerAvailabilityChanged: () => {}
  })
}

describe('RuntimeClientEventBus.hasListeners', () => {
  it('is false with no subscriber and true while one is attached', () => {
    const bus = createBus()
    expect(bus.hasListeners()).toBe(false)

    const off = bus.on(vi.fn())
    expect(bus.hasListeners()).toBe(true)

    off()
    expect(bus.hasListeners()).toBe(false)
  })

  it('counts listeners that opted out of terminal side effects', () => {
    const bus = createBus()
    bus.on(vi.fn(), { consumesTerminalSideEffects: false })

    expect(bus.hasListeners()).toBe(true)
    expect(bus.countTerminalSideEffectConsumers()).toBe(0)
  })
})
