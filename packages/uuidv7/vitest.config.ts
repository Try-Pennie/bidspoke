import { defineConfig } from 'vitest/config'

// The timezone is PINNED, and to a non-UTC one on purpose (#869).
//
// One assertion here exists to catch a day derived through local-time accessors
// instead of UTC, which is the L39 defect the archive's whole deletion guarantee
// rests on avoiding. That assertion can only fail where the host is not already
// UTC. GitHub runners are UTC, so left to the host it would have failed on a
// developer's machine and passed vacuously in CI, which is the one place it has
// to hold (L165: a fixture that cannot express the failure reads as convincing
// and proves nothing). Verified by deriving the day in local time and watching
// the test go red with TZ=UTC in the environment.
process.env.TZ = 'America/New_York'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
