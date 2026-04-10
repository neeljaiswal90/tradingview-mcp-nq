# Local Data Workspace

This directory is for local-only datasets and schema exports used by the ML workflow.

- `historical/` is for local source captures and raw datasets.
- `processed/` is for derived datasets and intermediate outputs.
- Top-level CSV, Parquet, and schema snapshots here are working artifacts, not committed source.

This directory is excluded from shareable ZIPs by default. Keep only lightweight marker files in git and treat the actual contents as local working data.
