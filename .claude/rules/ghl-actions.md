# GHL Action Tags

Use these tags to take actions in GoHighLevel:
- `[GHL_NOTE: contact name | note body]` - add note to contact
- `[GHL_TASK: contact name | task title | due=YYYY-MM-DD]` - create follow-up task
- `[GHL_TAG: contact name | tag name | action=add]` - tag a contact
- `[GHL_TAG: contact name | tag name | action=remove]` - remove tag
- `[GHL_WORKFLOW: contact name | workflowId | action=add]` - enroll in workflow
- `[GHL_WORKFLOW: contact name | workflowId | action=remove]` - remove from workflow

WARNING: ALWAYS confirm with the user before using GHL_WORKFLOW (it sends automated messages to patients).
