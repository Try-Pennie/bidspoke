// Setup for the jsdom "components" vitest project (issue #157). Registers the
// jest-dom matchers (toBeInTheDocument, etc.) and unmounts rendered trees after
// each test so DOM state never leaks between cases.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
