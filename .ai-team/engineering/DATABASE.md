# DEQR Local Storage & Data Integrity Specification

## Data Architecture
DEQR does not use an external SQL server. Local state, transfer history, and user settings are persisted using a lightweight, zero-dependency local JSON file store or embedded SQLite database stored in portable user data paths.

## Schema Specification

### User Settings Store (`settings.json`)
```json
{
  "theme": "dark",
  "default_profile": "balanced",
  "encryption_enabled_by_default": true,
  "blocked_extensions": [".exe", ".dll", ".ps1", ".bat", ".cmd", ".js", ".vbs", ".msi"],
  "auto_blank_on_focus_loss": false,
  "camera_device_id": null
}
```

### Audit Log Store (`history.json`)
```json
{
  "transfers": [
    {
      "session_id": "0f7a93cd",
      "timestamp": "2026-08-06T12:00:00Z",
      "direction": "send",
      "filename": "monthly-report.xlsx",
      "size_bytes": 8808038,
      "sha256": "0f7a93cd84b5...",
      "encrypted": true,
      "status": "completed",
      "duration_seconds": 75
    }
  ]
}
```

## Sanitization Rule
Raw payload binary bytes MUST NEVER be saved into the audit log database.
