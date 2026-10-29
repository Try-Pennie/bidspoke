# @bidspoke/slack-client

`createSlackClient` (#2337), the one place a Slack Web API client is built. It is
used:

- by the Worker's alerts and Settings routes, with a bot token;
- by the catalogue's ops Slack actions and the ops Slack verify, bound to a
  connection's fetch (`createSlackClient({ fetch })`), which sends through
  connectionFetch, since the library itself sends only through the global fetch.

It pins slack-web-api-client exactly, with retry and debug logging off, and
holds the only declaration of the library. `slack-calls-one-client.test.ts`
scans every workspace package and fails on any other Slack client or import.
