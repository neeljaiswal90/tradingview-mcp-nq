# Local Model Workspace

This directory stores local trained artifacts used by the ML sidecar.

- `catboost/` holds the production-oriented management models.
- `xgboost/` holds baseline or comparison artifacts.
- Model binaries and training metadata here are local working assets, not committed source.

This directory is excluded from shareable ZIPs by default unless you intentionally opt in with `-IncludeLocalAssets`.
