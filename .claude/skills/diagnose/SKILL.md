---
name: diagnose
description: System diagnostics and health report for Atlas
---
# Atlas Diagnostics

Run a comprehensive health check and report findings to the user.

## Steps

1. **Read health data** from `data/health.json` (written every 15 min by cron)
   - Report: health status (healthy/degraded/unhealthy), any issues
   - Report: message count, error count, error rate
   - Report: Claude call count, avg response time, timeout count

2. **Check circuit breaker status** from `data/health.json` `circuitBreakers` array
   - For each breaker, report: name, state (closed/open/half_open), total requests, error rate, avg response time
   - Flag any breakers in OPEN state with their last error
   - This shows which external services (GHL, Dashboard, Google, GBP, GA4, Meta, Supabase) are healthy vs degraded

3. **Check PM2 status** by running `pm2 jlist` and parsing JSON
   - Report: uptime, restart count, memory usage, CPU
   - Flag if restart count is unusually high (>5)

4. **Check recent errors** from `logs/error.log`
   - Tail last 20 lines
   - Summarize the most common error patterns

5. **Check git status** by running `git log --oneline -1` and `git status --short`
   - Report: last commit date and message
   - Flag if there are uncommitted changes
   - Note when the last auto-backup ran

6. **Check disk space** on the project drive

7. **Check subagent status** from `data/tasks.json`
   - Report: running tasks (count, PIDs, elapsed time)
   - Report: recent completed/failed tasks
   - Flag any stale tasks (running > timeout)

8. **Format a clear report** with sections:
   ```
   Atlas Health Report
   -------------------
   Status: [healthy/degraded/unhealthy]
   Uptime: [duration]
   Restarts: [count]

   Metrics
   Messages: [count] | Errors: [count] ([rate]%)
   Claude calls: [count] | Avg response: [time]s
   Timeouts: [count]

   API Services
   GHL: [OK/OPEN/PROBE] | [N] calls, [N]% err, avg [N]ms
   Dashboard: [OK/OPEN/PROBE] | [N] calls, [N]% err, avg [N]ms
   Google: [OK/OPEN/PROBE] | ...
   (etc. for each registered breaker)

   Subagents
   Running: [count] | Lifetime: [completed] done, [failed] failed

   Issues (if any)
   - [issue 1]
   - [issue 2]

   Recent Errors (if any)
   - [error summary]

   Git Backup
   Last commit: [date] -- [message]
   Status: [clean/dirty]

   Recommendations (if any)
   - [actionable suggestion]
   ```

9. If health is degraded or unhealthy, include specific recommendations:
   - High error rate -> check Supabase connectivity, Claude API status
   - Timeouts -> consider increasing CLAUDE_TIMEOUT_MS or simplifying prompts
   - High restart count -> check error.log for crash patterns
   - No recent git backup -> check git auth / remote connectivity
   - Circuit breaker OPEN -> API may be down, check service status page
   - Stale subagents -> may need manual cleanup via cancelTask()
