/**
 * Lines copied verbatim from the Bidspoke project's Supabase metrics feed
 * (`/customer/v1/privileged/metrics`) on 2026-10-09 at 00:47 UTC, minutes after the move
 * to Medium compute (#1928). Only the lines the memory check reads, their HELP and TYPE
 * lines, and a few neighbours from other services, so the parser is proven against the
 * real label shape rather than one written to suit it (L48).
 */
export const SUPABASE_METRICS_MEDIUM_AFTER_RESTART = [
  '# HELP node_memory_MemTotal_bytes Memory information field MemTotal_bytes.',
  '# TYPE node_memory_MemTotal_bytes gauge',
  'node_memory_MemTotal_bytes{supabase_project_ref="xvrmivmpfykwwtriqwpg",supabase_identifier="xvrmivmpfykwwtriqwpg",service_type="db"} 4.009828352e+09',
  '# HELP node_memory_SwapTotal_bytes Memory information field SwapTotal_bytes.',
  '# TYPE node_memory_SwapTotal_bytes gauge',
  'node_memory_SwapTotal_bytes{supabase_project_ref="xvrmivmpfykwwtriqwpg",supabase_identifier="xvrmivmpfykwwtriqwpg",service_type="db"} 1.073737728e+09',
  '# HELP node_memory_MemAvailable_bytes Memory information field MemAvailable_bytes.',
  '# TYPE node_memory_MemAvailable_bytes gauge',
  'node_memory_MemAvailable_bytes{supabase_project_ref="xvrmivmpfykwwtriqwpg",supabase_identifier="xvrmivmpfykwwtriqwpg",service_type="db"} 3.505897472e+09',
  '# HELP node_memory_MemFree_bytes Memory information field MemFree_bytes.',
  '# TYPE node_memory_MemFree_bytes gauge',
  'node_memory_MemFree_bytes{supabase_project_ref="xvrmivmpfykwwtriqwpg",supabase_identifier="xvrmivmpfykwwtriqwpg",service_type="db"} 3.011072e+09',
  '# HELP node_load1 1m load average.',
  '# TYPE node_load1 gauge',
  'node_load1{supabase_project_ref="xvrmivmpfykwwtriqwpg",supabase_identifier="xvrmivmpfykwwtriqwpg",service_type="db"} 0.31',
  '# HELP node_memory_SwapFree_bytes Memory information field SwapFree_bytes.',
  '# TYPE node_memory_SwapFree_bytes gauge',
  'node_memory_SwapFree_bytes{supabase_project_ref="xvrmivmpfykwwtriqwpg",supabase_identifier="xvrmivmpfykwwtriqwpg",service_type="db"} 1.073737728e+09',
  '# HELP node_vmstat_pswpout /proc/vmstat information field pswpout.',
  '# TYPE node_vmstat_pswpout untyped',
  'node_vmstat_pswpout{supabase_project_ref="xvrmivmpfykwwtriqwpg",supabase_identifier="xvrmivmpfykwwtriqwpg",service_type="db"} 0',
  'promhttp_metric_handler_requests_in_flight{supabase_project_ref="xvrmivmpfykwwtriqwpg",supabase_identifier="xvrmivmpfykwwtriqwpg",service_type="gotrue"} 1',
  'go_threads{supabase_project_ref="xvrmivmpfykwwtriqwpg",supabase_identifier="xvrmivmpfykwwtriqwpg",service_type="gotrue"} 8',
].join('\n')
