# Python ML Service

This directory is source code for the local ML inference sidecar.

- Keep `app.py`, `loaders.py`, `schemas.py`, tests, and dependency metadata here.
- Do not treat this directory as generated output.
- The service reads trained artifacts from the repo-level `models/` directory, not from a nested `python-ml-service/models/` folder.

If you create a shareable ZIP with `npm run zip:shareable`, this source directory is included by default.
