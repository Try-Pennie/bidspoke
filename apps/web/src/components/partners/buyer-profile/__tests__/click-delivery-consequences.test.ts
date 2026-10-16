/**
 * What a click delivery change does, said in the save bar (#1639, #2138 PM-6):
 * state by state through the route picker buyer_click_send uses, by route name
 * when the clicks move between two named routes (the settled design's "Clicks
 * from WY will go to DI4 instead of DV1"), and by address when a route keeps
 * its name and only its address moves.
 */
import { describe, it, expect } from 'vitest'
import { clickDeliveryConsequences, NODE_ADDRESS } from '../click-delivery-consequences'

const DV1 = { name: 'DV1', url: 'https://hooks.example.com/DV1', states: ['OR', 'WA', 'WY'] }
const DI4 = { name: 'DI4', url: 'https://hooks.example.com/DI4', states: [] as string[] }
const PATTERN = '(?<id>\\w+)'
const delivery = (dv1 = DV1, di4 = DI4) => ({ routes: [dv1, di4], success_pattern: PATTERN })

describe('clickDeliveryConsequences', () => {
  it('a state moved to another named route is said by the route names', () => {
    expect(clickDeliveryConsequences(delivery(), delivery({ ...DV1, states: ['OR', 'WA'] }))).toEqual(['Clicks from WY will go to DI4 instead of DV1.'])
  })

  it('a route whose address changed keeps its name, so the addresses say what moved', () => {
    expect(clickDeliveryConsequences(delivery(), delivery({ ...DV1, url: 'https://hooks.example.com/DV1-new' }))).toEqual([
      'Clicks from OR, WA, WY will go to https://hooks.example.com/DV1-new instead of https://hooks.example.com/DV1.',
    ])
  })

  it('from no delivery, the node address is named, with the success reply', () => {
    // In the order the states are walked: Alabama, a catch-all state, comes first.
    expect(clickDeliveryConsequences(null, delivery())).toEqual([
      `Clicks from every state no other route lists will go to ${DI4.url} instead of ${NODE_ADDRESS}.`,
      `Clicks from OR, WA, WY will go to ${DV1.url} instead of ${NODE_ADDRESS}.`,
      'A click counts as sent only when the reply matches (?<id>\\w+) instead of the success line on the workflow click send node.',
    ])
  })

  it('an edit that moves no click (a renamed route) says nothing', () => {
    expect(clickDeliveryConsequences(delivery(), delivery({ ...DV1, name: 'DV-One' }))).toEqual([])
  })
})
