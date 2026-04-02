// @ts-check
const { setupDevPlatform } = require('@cloudflare/next-on-pages/next-dev')

/** @type {import('next').NextConfig} */
const nextConfig = {}

if (process.env.NODE_ENV === 'development') {
  setupDevPlatform().catch(console.error)
}

module.exports = nextConfig
