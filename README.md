# Circular Auditable Review App

Local testing app for circular PDF auditable extraction quality review.

## Run

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://127.0.0.1:3001`.

The Express API runs on `http://127.0.0.1:3001`. Uploaded PDFs are saved under `data/uploads/`, and review history is saved in `data/history.json`.

## Build

```powershell
npm.cmd run build
npm.cmd run preview
```

The delete-history password is hardcoded as `Gravity`.
