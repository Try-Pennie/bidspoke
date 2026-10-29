# worker-tail

The tail consumer of the bidding Worker. It writes each execution's cost, and
copies three kinds of log line into the tables that checks read:

- each cron guard `FAILED OPEN` line into `cron_guard_fail_opens` (#2166), the
  second record the hourly cron guard check counts alongside its own KV record;
- each `[cron-once] delivery` line into `cron_tick_deliveries` (#2284), the
  record of every tick delivery the check reads to page on a tick that may have
  run twice;
- each `[slack] post outcome` line into `slack_post_outcomes` (#2364), the
  record the minute Slack refusal check reads to page through Better Stack when
  Slack refuses alert posts.

The checks themselves are described in
[docs/reference/observability.md](../../docs/reference/observability.md).
