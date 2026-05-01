# Sprint 5 — Ship Criteria Verification

Run each block. Check the box when verified. All 9 must pass before the sprint closes.

## 1. Blackboard live
- [ ] `data/atlas-blackboard.git` exists as bare repo (verify: `git --git-dir=data/atlas-blackboard.git rev-parse --is-bare-repository` returns `true`)
- [ ] At least 3 deliberations opened across at least 2 primitives during shakedown
- [ ] `git --git-dir=data/atlas-blackboard.git blame <branch>:final-memo.md` works on a real merged deliberation
- [ ] Every blackboard commit has a matching `ledger.ts` entry (spot-check 5)
- [ ] `bun run scripts/test-blackboard-gc.ts` archives synthetic 31d-old branches

## 2. Roles live
- [ ] `bun run db:psql -c "SELECT count(*) FROM role_pubkeys;"` returns ≥ 9 (8 named + ishtar-mirror)
- [ ] `/role list` shows 8 named seats
- [ ] At least 20 of 32 generated roles approved (`bun run db:psql -c "SELECT count(*) FROM role_pubkeys WHERE role_id NOT IN (...);"`)
- [ ] Auctioneer returns coherent 3-seat selections for 5 sample action types (verify by inspection)

## 3. Council in shadow → live (per surface)
- [ ] Critics fire on every patient-facing send for 7 days (check `council_votes` count by surface)
- [ ] Shadow log `data/council-shadow/` contains daily files
- [ ] <5% would-have-vetoed rate on Derek-approved actions (calibration)
- [ ] Trust-weighted tally math verified: sum of veto weights / total weights matches expected for sample case
- [ ] `/council promote outbound_email` flips it to live without errors

## 4. Marketplace in shadow → live (per task type)
- [ ] Routing logged for 7 days (`marketplace_bids` count grows)
- [ ] `data/marketplace-shadow-vs-live.md` shows shadow-vs-current diff
- [ ] `/marketplace promote newsletter-draft` flips it to live without errors

## 5. Joint Protocol — explicit-tag live, auto-fire shadow
- [ ] `[JOINT_DECISION:]` tag works end-to-end day 1 (open → mirror review → arbitrate → both Derek+Esther see)
- [ ] I3 auto-fire shortlist runs in shadow 7d (`joint_deliberations` shows shadow-mode rows)
- [ ] `/joint promote hire-fire` flips it to live without errors

## 6. Telegram commands operational
- [ ] `/council` returns useful output
- [ ] `/marketplace domain newsletter` returns useful output
- [ ] `/joint list` returns useful output
- [ ] `/role list pending` returns useful output

## 7. Test suite green
- [ ] `bun test tests/sprint5/` all pass
- [ ] `bun test` full suite passes (no regression)
- [ ] Replay harness scores ≥ Sprint 4 baseline

## 8. No regression in Sprint 1-4 modules
- [ ] `bun test tests/ledger.test.ts` PASS
- [ ] `bun test tests/gate-integration.test.ts` PASS
- [ ] `bun test tests/cortex.test.ts` PASS
- [ ] `bun test tests/procedures.test.ts` PASS
- [ ] `bun test tests/causal-graph.test.ts` PASS
- [ ] `bun test tests/derek-twin.test.ts` PASS
- [ ] `bun test tests/dream-engine.test.ts` PASS

## 9. Atlas restart healthy on Windows + pm2
- [ ] `pm2 restart atlas` cold-starts in < 30s
- [ ] `pm2 logs atlas --lines 50` shows 4 new Sprint 5 crons registered
- [ ] Persistent-pool processes for atlas + ishtar both come up
- [ ] `/diagnose` reports all subsystems green
