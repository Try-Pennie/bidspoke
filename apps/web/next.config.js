// @ts-check
const { setupDevPlatform } = require('@cloudflare/next-on-pages/next-dev')

/** @type {import('next').NextConfig} */
const nextConfig = {
  // `@bidspoke/uuidv7` ships TypeScript source rather than a build artifact, so
  // Next has to transpile it like app code. It is source rather than a build step
  // because it exists to be ONE implementation the Worker and the browser share
  // (#869), and a compile step is another place the two could end up on different
  // versions of it.
  transpilePackages: ['@bidspoke/references', '@bidspoke/uuidv7', '@bidspoke/script-hygiene', '@bidspoke/buyer-profile', '@bidspoke/node-types', '@bidspoke/workflow-definition', '@bidspoke/partner-page-live', '@bidspoke/partner-history'],
}

if (process.env.NODE_ENV === 'development') {
  setupDevPlatform().catch(console.error)
}

module.exports = nextConfig
