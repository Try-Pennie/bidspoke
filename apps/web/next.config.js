// @ts-check
const { setupDevPlatform } = require('@cloudflare/next-on-pages/next-dev')

// Monaco's own DOMPurify copy is swapped for the npm package (#2695); the rule
// and why live in monaco-dompurify-swap.js.
const { VENDORED_REQUEST, isMonacoVendoredDompurify, npmDompurifyPath } = require('./monaco-dompurify-swap')
const NPM_DOMPURIFY = npmDompurifyPath(__dirname)

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config, { webpack }) {
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(VENDORED_REQUEST, (resource) => {
        if (isMonacoVendoredDompurify(resource.request, resource.context)) resource.request = NPM_DOMPURIFY
      }),
    )
    return config
  },
  // `@bidspoke/uuidv7` ships TypeScript source rather than a build artifact, so
  // Next has to transpile it like app code. It is source rather than a build step
  // because it exists to be ONE implementation the Worker and the browser share
  // (#869), and a compile step is another place the two could end up on different
  // versions of it.
  transpilePackages: ['@bidspoke/references', '@bidspoke/uuidv7', '@bidspoke/script-hygiene', '@bidspoke/buyer-profile', '@bidspoke/node-types', '@bidspoke/workflow-definition', '@bidspoke/partner-page-live', '@bidspoke/partner-history', '@bidspoke/service-catalogue'],
}

if (process.env.NODE_ENV === 'development') {
  setupDevPlatform().catch(console.error)
}

module.exports = nextConfig
