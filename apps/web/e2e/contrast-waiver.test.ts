// @vitest-environment jsdom
/**
 * The contrast waiver (#2137) lets through only the partners form's known grey
 * hints, until PR13 (#2144) picks their shade. Its scope is narrow on purpose:
 * a node in the main document, inside the named surface, in the named class.
 * Anything else, a node in an iframe or shadow root among them, is never
 * waived, so it fails the scan rather than passing unseen.
 */
import { describe, expect, it } from 'vitest'
import { waivableSelector, waivedInDocument } from './contrast-waiver'

describe('waivableSelector', () => {
  it('takes only a node in the main document', () => {
    expect(waivableSelector(['#a > p'])).toBe('#a > p')
    expect(waivableSelector(['iframe#x', '#a > p'])).toBeNull()
    expect(waivableSelector([['#host', '#inner']])).toBeNull()
    expect(waivableSelector('#a')).toBeNull()
    expect(waivableSelector([])).toBeNull()
  })
})

describe('waivedInDocument', () => {
  const doc = () => {
    document.body.innerHTML = `
      <div data-form-pane=""><p id="hint" class="text-gray-500">hint</p><p id="plain">plain</p></div>
      <aside><p id="list" class="text-gray-500">list</p></aside>`
    return document
  }
  const waiver = { className: 'text-gray-500', within: '[data-form-pane]', issue: '#2144' }

  it('waives the grey hint inside the form pane, and nothing outside the class or the pane', () => {
    const d = doc()
    expect(waivedInDocument(d, '#hint', waiver)).toBe(true)
    expect(waivedInDocument(d, '#plain', waiver)).toBe(false)
    expect(waivedInDocument(d, '#list', waiver)).toBe(false)
    expect(waivedInDocument(d, '#missing', waiver)).toBe(false)
  })
})
