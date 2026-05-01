# Atlas Prime — Executable Constitution (Sprint 1 starter set)
#
# Each invariant is a rule that MUST hold before any matching tool call dispatches.
# Violations block the action and return { allowed: false, reason: <clause name> }.
#
# Schema:
#   invariants: list of { name, applies_to, when, require | forbid }
#   applies_to: tool tag (e.g. "SEND", "CAL_ADD", "GHL_WORKFLOW")
#   when: optional JMESPath-ish guard on args (plain dot-path predicates)
#   require: list of predicates that must all be true
#   forbid:  list of predicates any of which being true blocks the action
#
# Predicate form:
#   - { path: <dot-path into args>, op: <in|equals|matches|not_in|present>, value: ... }

version: 2

invariants:

  - name: NoEmailOutsideAllowlist
    applies_to: SEND
    require:
      - { path: to, op: matches, value: "^[^@]+@(pvmedispa\\.com|medicalaestheticsassociation\\.com|gmail\\.com|besafehealthcare\\.com)$" }

  - name: NoPatientRecordDelete
    applies_to: GHL_DELETE
    forbid:
      - { path: _always, op: equals, value: true }

  - name: NoTelegramSendToUnknownChat
    applies_to: TELEGRAM_SEND
    require:
      - { path: chatId, op: present }

  - name: CalendarInviteRequiresTitle
    applies_to: CAL_ADD
    require:
      - { path: title, op: present }

  - name: GHLWorkflowRequiresExplicitApproval
    applies_to: GHL_WORKFLOW
    when: { path: action, op: equals, value: add }
    require:
      - { path: approved_by_user, op: equals, value: true }

  - name: AdSpendChangeCap
    applies_to: META_ADS_UPDATE
    forbid:
      - { path: spend_delta_usd, op: greater_than, value: 100 }

  # Sprint 5: Society substrate — Council + Joint Protocol invariants

  - name: outbound_email_requires_council
    applies_to: gmail.send
    when:
      path: to
      op: matches
      value: '@(?!pvmedispa\.com|medicalaestheticsassociation\.com|bsfehealth\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    require:
      - { path: council_review_id, op: present }

  - name: outbound_email_draft_requires_council
    applies_to: gmail.draft
    when:
      path: to
      op: matches
      value: '@(?!pvmedispa\.com|medicalaestheticsassociation\.com|bsfehealth\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    require:
      - { path: council_review_id, op: present }

  - name: brevo_campaign_requires_council
    applies_to: brevo.campaign.send
    require:
      - { path: council_review_id, op: present }

  - name: cal_invite_external_requires_council
    applies_to: google.calendar.create
    when:
      path: has_external_attendee
      op: equals
      value: true
    require:
      - { path: council_review_id, op: present }

  - name: joint_action_requires_joint_deliberation
    applies_to: _any_
    when:
      path: joint_required
      op: equals
      value: true
    require:
      - { path: joint_deliberation_id, op: present }

# Shield-mode invariants (apply regardless of tag — belt and suspenders)
shield:
  - name: NoActionWithoutLedgerEntry
    description: Every action emitted must be accompanied by a prior ledger append
    enforced_by: relay
